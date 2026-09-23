import { siteUrl } from "@/lib/schema/builders";
import { now } from "@/lib/clock";
import { featuredPlanIdFor } from "@/lib/billing/featured-plan";
import type { PayPalClient } from "@/lib/billing/paypal";
import {
  attachFeaturedProvider,
  cancelBid,
  clearPendingRaise,
  confirmListingBids,
  createFeaturedSubscription,
  currentFeaturedSubscription,
  ensureSpot,
  insertBid,
  listingBids,
  listingForBidding,
  lockListing,
  setBidAmount,
  setBidPending,
  spotAreaExists,
  spotBids,
  updateFeaturedSubscription,
  type BidRow,
  type BiddingListing,
  type IneligibleReason,
  type SpotKey,
  type SpotRow,
} from "@/lib/db/queries/spots";
import type { TestDb } from "@/lib/db/types";
import type { Viewer } from "@/lib/db/viewer";
import {
  FEATURED_CANCELLED_PATH,
  FEATURED_RETURN_PATH,
  SPOTS_SYSTEM_VIEWER,
  settleSpots,
  type QuantityChange,
} from "./engine";
import {
  quantityFor,
  rankBids,
  UNIT_CENTS,
  validateBid,
  validateLower,
  type BidRejection,
  type SpotStanding,
} from "./rank";

/**
 * What an owner can do with a spot: bid, raise, lower, cancel.
 *
 * Every path re-derives ownership and eligibility inside the caller's
 * transaction; the page that showed the form is not a boundary. The listing
 * row is locked for the length of the transaction (I8), so two bids from the
 * same owner serialise and the second sees the first's subscription. The
 * PayPal call — create on the first bid, revise afterwards — happens INSIDE
 * the transaction so a provider failure throws and nothing is written.
 *
 * What is confirmed immediately and what waits:
 *
 *   - a first bid, and a raise, are `pending` until a PayPal payload carries
 *     a quantity that covers them (`lib/spots/webhook.ts`). Until then they
 *     hold no position. `requested_quantity` records what was asked.
 *   - a lowering and a cancellation take effect now: the buyer is choosing to
 *     pay less, and nothing has to be confirmed before they may.
 *   - while the first approval is outstanding, nothing else can be changed:
 *     the owner is sent back to finish it (`awaiting-approval`).
 */

export type BidOutcome =
  | { readonly outcome: "not-configured" }
  | { readonly outcome: "not-owner" }
  | { readonly outcome: "not-eligible"; readonly reason: IneligibleReason }
  | { readonly outcome: "no-such-area" }
  | { readonly outcome: "not-your-category" }
  | { readonly outcome: "spot-closed" }
  | { readonly outcome: "rejected"; readonly reason: BidRejection; readonly minimum: number }
  | { readonly outcome: "unchanged" }
  /** The first approval (or an earlier revision) is still outstanding; finish it first. */
  | { readonly outcome: "awaiting-approval"; readonly approveUrl: string | null }
  /** Approve at PayPal: the subscription (first time) or the revision. */
  | { readonly outcome: "approval"; readonly approveUrl: string | null; readonly paths: readonly string[] }
  /** Took effect now. `approveUrl` when PayPal wants the lower quantity approved too. */
  | { readonly outcome: "applied"; readonly approveUrl: string | null; readonly paths: readonly string[] };

export interface PlaceBidInput {
  readonly client: PayPalClient | null;
  readonly env?: Record<string, string | undefined>;
  readonly viewer: Viewer;
  readonly profileId: string;
  readonly listingId: string;
  readonly spot: SpotKey;
  readonly amountCents: number;
  readonly ip: string | null;
  readonly subscriberEmail?: string | null;
}

/** Whether this listing may bid on this spot at all: its categories, any area. */
export function spotAllowedFor(listing: BiddingListing, key: SpotKey): boolean {
  return key.categoryId === null || listing.categoryIds.includes(key.categoryId);
}

/** What the bidder is up against: the others' featured amounts, highest first. */
export function standingFor(spot: SpotRow, bids: readonly BidRow[], listingId: string): SpotStanding {
  return {
    floorCents: spot.floorCents,
    positions: spot.positions,
    featured: bids
      .filter((b) => b.listingId !== listingId && b.status === "active" && b.position !== null)
      .map((b) => b.amountCents)
      .sort((a, b) => b - a),
  };
}

/**
 * The quantity this listing will need once `amountCents` is confirmed on
 * `spot`: its other featured bids as they stand, plus this one if it would
 * hold a position among the spot's confirmed bids. The new amount is set
 * NOW — a raise queues behind everyone already at that amount (I1).
 */
export function projectedQuantity(
  spot: SpotRow,
  spotBidRows: readonly BidRow[],
  otherBids: readonly BidRow[],
  listingId: string,
  amountCents: number,
): number {
  const hypothetical = [
    ...spotBidRows.filter((b) => b.listingId !== listingId),
    { id: "hypothetical", listingId, amountCents, amountSetAt: now(), status: "active" as const },
  ];
  const mine = rankBids(hypothetical, spot.positions).find((r) => r.listingId === listingId);
  const elsewhere = quantityFor(otherBids.map((b) => ({ amountCents: b.amountCents, status: b.status, position: b.position })));
  return elsewhere + (mine === undefined || mine.position === null ? 0 : amountCents / UNIT_CENTS);
}

export async function placeBid(tx: TestDb, input: PlaceBidInput): Promise<BidOutcome> {
  if (input.client === null) return { outcome: "not-configured" };
  const planId = featuredPlanIdFor(input.env ?? process.env);
  if (planId === null) return { outcome: "not-configured" };

  const listing = await listingForBidding(tx, input.viewer, {
    listingId: input.listingId,
    profileId: input.profileId,
  });
  if (listing === null) return { outcome: "not-owner" };
  if (!listing.eligible) return { outcome: "not-eligible", reason: listing.reason ?? "no-subscription" };
  if (!spotAllowedFor(listing, input.spot)) return { outcome: "not-your-category" };
  if (!(await spotAreaExists(tx, input.viewer, input.spot))) return { outcome: "no-such-area" };

  // Everything below reads and writes this listing's subscription and bids.
  await lockListing(tx, input.viewer, listing.id);

  const spot = await ensureSpot(tx, input.viewer, input.spot);
  if (spot.status === "closed") return { outcome: "spot-closed" };

  const bids = await spotBids(tx, input.viewer, spot.id);
  const own = bids.find((b) => b.listingId === listing.id) ?? null;
  const standing = standingFor(spot, bids, listing.id);
  const mine = await listingBids(tx, input.viewer, { listingId: listing.id, profileId: input.profileId });
  const elsewhere = mine.filter((b) => b.spotId !== spot.id);
  const deps = { client: input.client, env: input.env };
  const sub = await currentFeaturedSubscription(tx, input.viewer, listing.id, input.profileId);

  // The first approval has not happened: nothing can be added to, lowered
  // or withdrawn from it. Back to PayPal.
  if (sub !== null && (sub.status === "approval_pending" || sub.providerSubscriptionId === null)) {
    return { outcome: "awaiting-approval", approveUrl: sub.approveUrl };
  }
  const providerId = sub?.providerSubscriptionId ?? null;

  /* --------------------------------------------------- withdraw a raise */
  if (own !== null && input.amountCents === own.amountCents) {
    if (own.pendingAmountCents === null) return { outcome: "unchanged" };
    await clearPendingRaise(tx, input.viewer, { bidId: own.id, ip: input.ip });
    // The revise PayPal was asked for is moot; the sync settles it.
    const settled = await settleSpots(tx, [spot.id], deps, [listing.id]);
    return { outcome: "applied", approveUrl: null, paths: settled.paths };
  }

  /* ------------------------------------------------------------- lowering */
  if (own !== null && input.amountCents < own.amountCents) {
    const check = validateLower(input.amountCents, spot.floorCents);
    if (!check.ok) return { outcome: "rejected", reason: check.reason, minimum: check.minimum };
    await setBidAmount(tx, input.viewer, { bidId: own.id, amountCents: input.amountCents, ip: input.ip });
    // The owner chose this; they are not "outbid" by it (Task 45 I1).
    const settled = await settleSpots(tx, [spot.id], deps, [], { silentListingId: listing.id });
    return { outcome: "applied", approveUrl: approvalFor(settled.changes, listing.id), paths: settled.paths };
  }

  /* --------------------------------------------------- first bid or raise */
  const check = validateBid(input.amountCents, standing);
  if (!check.ok) return { outcome: "rejected", reason: check.reason, minimum: check.minimum };

  const quantity = projectedQuantity(spot, bids, elsewhere, listing.id, input.amountCents);

  if (sub === null) {
    // First subscription for this listing: pending row, pending bid, then
    // PayPal — whose failure throws and rolls all of it back.
    const subscriptionId = await createFeaturedSubscription(tx, input.viewer, {
      listingId: listing.id,
      profileId: input.profileId,
      planId,
      quantity,
      ip: input.ip,
    });
    if (own === null) {
      await insertBid(tx, input.viewer, {
        spotId: spot.id,
        listingId: listing.id,
        subscriptionId,
        amountCents: input.amountCents,
        status: "pending",
        ip: input.ip,
      });
    } else {
      await setBidPending(tx, input.viewer, { bidId: own.id, pendingAmountCents: input.amountCents, ip: input.ip });
    }
    const created = await input.client.createSubscription({
      planId,
      customId: subscriptionId,
      returnUrl: siteUrl(FEATURED_RETURN_PATH),
      cancelUrl: siteUrl(FEATURED_CANCELLED_PATH),
      subscriberEmail: input.subscriberEmail ?? null,
      quantity,
    });
    await attachFeaturedProvider(tx, input.viewer, subscriptionId, {
      providerSubscriptionId: created.id,
      approveUrl: created.approveUrl,
    });
    return { outcome: "approval", approveUrl: created.approveUrl, paths: [] };
  }

  // A live subscription exists (active, past_due or paused). The bid waits
  // for PayPal to confirm the quantity that covers it; `requested_quantity`
  // records what is being asked (C1).
  if (own === null) {
    await insertBid(tx, input.viewer, {
      spotId: spot.id,
      listingId: listing.id,
      subscriptionId: sub.id,
      amountCents: input.amountCents,
      status: "pending",
      ip: input.ip,
    });
  } else {
    await setBidPending(tx, input.viewer, { bidId: own.id, pendingAmountCents: input.amountCents, ip: input.ip });
  }

  if (input.client.reviseSubscription === undefined || providerId === null) return { outcome: "not-configured" };
  if (sub.status === "paused") {
    // Resume first: a revise on a suspended subscription is refused.
    if (input.client.activateSubscription === undefined) return { outcome: "not-configured" };
    await input.client.activateSubscription(providerId, "A new bid was placed");
    await updateFeaturedSubscription(
      tx,
      input.viewer,
      sub.id,
      { status: "active", pausedAt: null },
      { action: "spots.resumed", actorId: input.profileId, ip: input.ip, meta: { listingId: listing.id } },
    );
  }
  if (quantity === sub.quantity) {
    // Already consented to exactly this quantity (a paused listing bidding
    // again at its old amount): nothing to ask, confirm on our own evidence.
    await updateFeaturedSubscription(
      tx,
      input.viewer,
      sub.id,
      { requestedQuantity: quantity, reviseRequestedAt: null, approveUrl: null },
      { action: "spots.revise_settled", actorId: input.profileId, ip: input.ip, meta: { listingId: listing.id, quantity } },
    );
    const touched = await confirmListingBids(tx, SPOTS_SYSTEM_VIEWER, listing.id);
    const settled = await settleSpots(tx, [spot.id, ...touched], deps);
    return { outcome: "applied", approveUrl: null, paths: settled.paths };
  }
  const revised = await input.client.reviseSubscription(providerId, {
    quantity,
    returnUrl: siteUrl(FEATURED_RETURN_PATH),
    cancelUrl: siteUrl(FEATURED_CANCELLED_PATH),
  });
  await updateFeaturedSubscription(
    tx,
    input.viewer,
    sub.id,
    { requestedQuantity: quantity, reviseRequestedAt: now(), approveUrl: revised.approveUrl },
    { action: "spots.revise_requested", actorId: input.profileId, ip: input.ip, meta: { listingId: listing.id, quantity } },
  );
  return { outcome: "approval", approveUrl: revised.approveUrl, paths: [] };
}

export interface CancelBidInput {
  readonly client: PayPalClient | null;
  readonly env?: Record<string, string | undefined>;
  readonly viewer: Viewer;
  readonly profileId: string;
  readonly listingId: string;
  readonly spotId: string;
  readonly ip: string | null;
}

export type CancelBidOutcome =
  | { readonly outcome: "not-owner" }
  | { readonly outcome: "no-bid" }
  | { readonly outcome: "awaiting-approval"; readonly approveUrl: string | null }
  | { readonly outcome: "applied"; readonly approveUrl: string | null; readonly paths: readonly string[] };

/**
 * Cancelling takes effect now. The quantity sync that follows tells PayPal
 * to bill less from the next cycle — or, when nothing featured is left,
 * suspends the subscription so the next cycle is not charged.
 */
export async function cancelOwnBid(tx: TestDb, input: CancelBidInput): Promise<CancelBidOutcome> {
  const listing = await listingForBidding(tx, input.viewer, {
    listingId: input.listingId,
    profileId: input.profileId,
  });
  if (listing === null) return { outcome: "not-owner" };
  await lockListing(tx, input.viewer, listing.id);

  const sub = await currentFeaturedSubscription(tx, input.viewer, listing.id, input.profileId);
  if (sub !== null && (sub.status === "approval_pending" || sub.providerSubscriptionId === null)) {
    return { outcome: "awaiting-approval", approveUrl: sub.approveUrl };
  }

  const mine = await listingBids(tx, input.viewer, { listingId: listing.id, profileId: input.profileId });
  const own = mine.find((b) => b.spotId === input.spotId);
  if (own === undefined) return { outcome: "no-bid" };

  await cancelBid(tx, input.viewer, { bidId: own.id, ip: input.ip });
  const settled = await settleSpots(tx, [input.spotId], { client: input.client, env: input.env }, [listing.id]);
  return { outcome: "applied", approveUrl: approvalFor(settled.changes, listing.id), paths: settled.paths };
}

function approvalFor(changes: readonly QuantityChange[], listingId: string): string | null {
  return changes.find((c) => c.listingId === listingId)?.approveUrl ?? null;
}

/** Re-exported for the action layer, which never imports the worker's viewer. */
export { SPOTS_SYSTEM_VIEWER };
