import { notifySpotOutbid, type SpotOutbidJobPayload } from "@/lib/email/notify";
import { markOutbidNotified } from "@/lib/db/queries/spots";
import type { TestDb } from "@/lib/db/types";
import type { Viewer } from "@/lib/db/viewer";
import { minimumToEnter, minimumToTakeFirst, type BidStatus, type RankedBid } from "./rank";

/**
 * Who to tell after a re-rank (Task 45, requirement 1).
 *
 * A re-rank hands back every confirmed bid with its new position. Compared
 * with the positions the rows held before, two things are worth an email:
 * a bid that held first and no longer does, and a bid that held any place
 * and now holds none. Moving up, holding still, entering, and a first
 * ranking (nothing to lose yet) are silent.
 *
 * Debounced to one email per bid per hour: a spot with three active bidders
 * can re-rank several times in a minute, and an owner told once with the
 * amount it takes to get back is told everything. The mark is a column on
 * the bid (`outbid_notified_at`) and the claim is one UPDATE, so the same
 * change re-ranked twice in one transaction queues one job.
 *
 * The payload names the event and the amount it took to get back AT THE
 * TIME (the queue row is the record of what the owner was told about); the
 * worker recomputes the amount when it sends, so a bid that regained its
 * place in the meantime gets no email at all and a later change is not
 * quoted stale.
 */

export type OutbidKind = SpotOutbidJobPayload["kind"];

export interface OutbidChange {
  readonly bidId: string;
  readonly listingId: string;
  readonly kind: OutbidKind;
  readonly from: number;
  readonly to: number | null;
}

export interface HeldBid {
  readonly id: string;
  readonly listingId: string;
  readonly position: number | null;
  readonly status: BidStatus;
}

export const OUTBID_DEBOUNCE_MS = 60 * 60 * 1000;

/**
 * The same nil-uuid system viewer as `SPOTS_SYSTEM_VIEWER` in ./engine.ts,
 * declared here rather than imported: engine.ts imports this module, and an
 * import back would be a cycle whose constant is undefined at load.
 */
const SYSTEM: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };

/** Pure: what changed for the worse between the rows as they were and the ranking as it is. */
export function positionChanges(
  before: readonly HeldBid[],
  after: readonly RankedBid[],
): OutbidChange[] {
  const next = new Map(after.map((r) => [r.id, r.position]));
  const out: OutbidChange[] = [];
  for (const b of before) {
    if (b.status !== "active" || b.position === null) continue;
    const to = next.get(b.id) ?? null;
    if (to === null) {
      out.push({ bidId: b.id, listingId: b.listingId, kind: "dropped-out", from: b.position, to: null });
    } else if (b.position === 1 && to > 1) {
      out.push({ bidId: b.id, listingId: b.listingId, kind: "lost-first", from: 1, to });
    }
  }
  return out;
}

export interface SpotStandingInput {
  readonly id: string;
  readonly floorCents: number;
  readonly positions: number;
}

/** What the changed bid's owner needs now: to retake first, or to re-enter. */
export function amountToRetake(
  spot: SpotStandingInput,
  after: readonly RankedBid[],
  change: OutbidChange,
): number {
  const featured = after
    .filter((r) => r.position !== null && r.listingId !== change.listingId)
    .map((r) => r.amountCents);
  const standing = { floorCents: spot.floorCents, positions: spot.positions, featured };
  return change.kind === "lost-first" ? minimumToTakeFirst(standing) : minimumToEnter(standing);
}

/**
 * Queues the emails for a spot's re-rank, inside the transaction that wrote
 * it. Returns the changes that were queued (the rest were debounced).
 */
export async function notifyOutbid(
  tx: TestDb,
  spot: SpotStandingInput,
  before: readonly HeldBid[],
  after: readonly RankedBid[],
  /** The listing whose owner made this change: lowering your own bid is not being outbid. */
  silentListingId: string | null = null,
): Promise<OutbidChange[]> {
  const queued: OutbidChange[] = [];
  for (const change of positionChanges(before, after)) {
    if (change.listingId === silentListingId) continue;
    const fresh = await markOutbidNotified(tx, SYSTEM, change.bidId, OUTBID_DEBOUNCE_MS);
    if (!fresh) continue;
    await notifySpotOutbid(tx, SYSTEM, {
      bidId: change.bidId,
      kind: change.kind,
      amountCents: amountToRetake(spot, after, change),
    });
    queued.push(change);
  }
  return queued;
}

/* ----------------------------------------------------- the email's numbers */

/** The bidding page with a spot and an amount prefilled — the email's one-click link. */
export function prefilledBidPath(listingId: string, keyString: string, amountUnits: number): string {
  const q = new URLSearchParams({ bid: keyString, amount: String(amountUnits) });
  return `/account/listings/${listingId}/featured?${q.toString()}`;
}

export function leaderboardPath(spotId: string): string {
  return `/spots/${spotId}`;
}
