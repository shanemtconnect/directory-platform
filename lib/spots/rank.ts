/**
 * The featured-spot ranking, as pure functions.
 *
 * Everything money-shaped in featured placement is decided here and written
 * by `lib/db/queries/spots.ts`: who holds which position, what a newcomer has
 * to bid, and — the invariant this module exists for — how much each listing
 * is charged. Keeping it free of the database is what lets every transition
 * (a third bidder arriving, a leader lowering, a cancellation, a lapse) be
 * proved against a table of amounts rather than a fixture.
 *
 * Amounts are minor units throughout (cents, pence). Bids are whole major
 * units, because the PayPal plan behind them is "one unit per major unit per
 * month" and its quantity is an integer.
 */

export type BidStatus = "pending" | "active" | "outbid" | "cancelled";

export interface RankableBid {
  readonly id: string;
  readonly listingId: string;
  readonly amountCents: number;
  readonly createdAt: Date;
  readonly status: BidStatus;
}

export interface RankedBid {
  readonly id: string;
  readonly listingId: string;
  readonly amountCents: number;
  /** 1..positions while featured; null while outbid. */
  readonly position: number | null;
}

/** One major unit, in minor units. */
export const UNIT_CENTS = 100;

/** Taking first place costs at least this much more than the current top bid. */
export const FIRST_PLACE_PERCENT = 10;
export const FIRST_PLACE_MIN_STEP_CENTS = 5 * UNIT_CENTS;

/** Entering a full spot costs at least this much more than the lowest featured bid. */
export const ENTER_STEP_CENTS = 1 * UNIT_CENTS;

/**
 * Only a CONFIRMED bid holds a place in the ranking. A pending bid is one
 * PayPal has not yet agreed to charge for, and ranking it would hand out a
 * position on a promise; a cancelled one has left.
 */
const RANKS: readonly BidStatus[] = ["active", "outbid"];

/**
 * `amount DESC, created_at ASC` — and then id, so two rows created in the
 * same transaction with the same amount still sort the same way every time.
 * The top `positions` are featured; the rest are outbid and, by
 * `quantityFor` below, charged nothing.
 */
export function rankBids(bids: readonly RankableBid[], positions: number): RankedBid[] {
  const live = bids.filter((b) => RANKS.includes(b.status));
  live.sort((a, b) => {
    if (a.amountCents !== b.amountCents) return b.amountCents - a.amountCents;
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return live.map((b, i) => ({
    id: b.id,
    listingId: b.listingId,
    amountCents: b.amountCents,
    position: i < positions ? i + 1 : null,
  }));
}

export function roundUpToUnit(cents: number): number {
  return Math.ceil(cents / UNIT_CENTS) * UNIT_CENTS;
}

/**
 * What a bidder is up against: the spot's floor and capacity, and the
 * amounts currently featured — highest first, and EXCLUDING the bidder's own
 * bid if it has one. A listing raising its own bid competes with the others,
 * not with itself.
 */
export interface SpotStanding {
  readonly floorCents: number;
  readonly positions: number;
  readonly featured: readonly number[];
}

function top(standing: SpotStanding): number | null {
  return standing.featured.length === 0 ? null : Math.max(...standing.featured);
}

function lowest(standing: SpotStanding): number | null {
  return standing.featured.length === 0 ? null : Math.min(...standing.featured);
}

/** ≥ max(top + 10%, top + 5), whole units, never below the floor. */
export function minimumToTakeFirst(standing: SpotStanding): number {
  const t = top(standing);
  if (t === null) return standing.floorCents;
  const step = Math.max(
    Math.ceil((t * FIRST_PLACE_PERCENT) / 100),
    FIRST_PLACE_MIN_STEP_CENTS,
  );
  return Math.max(standing.floorCents, roundUpToUnit(t + step));
}

/** ≥ lowest featured + 1 once the spot is full; the floor while it is not. */
export function minimumToEnter(standing: SpotStanding): number {
  const l = lowest(standing);
  if (l === null || standing.featured.length < standing.positions) return standing.floorCents;
  return Math.max(standing.floorCents, roundUpToUnit(l + ENTER_STEP_CENTS));
}

export type BidRejection = "not-whole-units" | "below-floor" | "below-entry" | "below-first";

export type BidValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: BidRejection; readonly minimum: number };

/**
 * A NEW amount for a spot — a first bid, or a raise (with the bidder's own
 * bid taken out of `featured`).
 *
 * Beating the top bid means taking first, which needs the first-place
 * increment even when a position is free. Matching it does not: the tie goes
 * to the earlier bid, so the newcomer lands second. Anything below the top
 * only has to clear the entry rule — the lowest featured bid plus one when
 * the spot is full, the floor when it is not.
 */
export function validateBid(amountCents: number, standing: SpotStanding): BidValidation {
  const t = top(standing);
  const takesFirst = t === null || amountCents > t;
  const minimum = takesFirst ? minimumToTakeFirst(standing) : minimumToEnter(standing);

  if (!Number.isInteger(amountCents) || amountCents % UNIT_CENTS !== 0) {
    return { ok: false, reason: "not-whole-units", minimum };
  }
  if (amountCents < standing.floorCents) {
    return { ok: false, reason: "below-floor", minimum: standing.floorCents };
  }
  if (amountCents < minimum) {
    return { ok: false, reason: takesFirst ? "below-first" : "below-entry", minimum };
  }
  return { ok: true };
}

/**
 * Lowering is always allowed down to the floor: the bidder is choosing to
 * pay less, and the re-rank that follows may cost them their position. That
 * is theirs to decide.
 */
export function validateLower(amountCents: number, floorCents: number): BidValidation {
  if (!Number.isInteger(amountCents) || amountCents % UNIT_CENTS !== 0) {
    return { ok: false, reason: "not-whole-units", minimum: floorCents };
  }
  if (amountCents < floorCents) return { ok: false, reason: "below-floor", minimum: floorCents };
  return { ok: true };
}

export interface ChargeableBid {
  readonly amountCents: number;
  readonly status: BidStatus;
  readonly position: number | null;
}

/**
 * THE invariant: a listing pays for the positions it holds and nothing else.
 *
 * The PayPal quantity is the sum of this listing's bids that are both
 * confirmed (`active`) and currently featured (`position` set), in whole
 * units. An outbid bid contributes nothing; a pending one contributes
 * nothing until it is confirmed; a cancelled one is gone. Recomputed for
 * every listing in a spot whenever any bid in that spot changes.
 */
export function quantityFor(bids: readonly ChargeableBid[]): number {
  let cents = 0;
  for (const b of bids) {
    if (b.status === "active" && b.position !== null) cents += b.amountCents;
  }
  return Math.round(cents / UNIT_CENTS);
}

/** The sentence a bidder sees. `format` renders minor units for the site. */
export function bidRejectionMessage(
  reason: BidRejection,
  minimum: number,
  format: (cents: number) => string,
): string {
  switch (reason) {
    case "not-whole-units":
      return "Bids are whole amounts — no pence or cents.";
    case "below-floor":
      return `The lowest bid this spot takes is ${format(minimum)} a month.`;
    case "below-entry":
      return `To be featured here you need to bid at least ${format(minimum)} a month.`;
    case "below-first":
      return `To take first place you need to bid at least ${format(minimum)} a month.`;
  }
}
