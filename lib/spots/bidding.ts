import { siteUrl } from "@/lib/schema/builders";
import { now } from "@/lib/clock";
import { featuredPlanIdFor } from "@/lib/billing/featured-plan";
import type { PayPalClient } from "@/lib/billing/paypal";
import {
  attachFeaturedProvider,
  cancelBid,
  createFeaturedSubscription,
  currentFeaturedSubscription,
  ensureSpot,
  insertBid,
  listingBids,
  listingForBidding,
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
  validateBid,
  validateLower,
  type BidRejection,
  type SpotStanding,
} from "./rank";

/**
 * What an owner can do with a spot: bid, raise, lower, cancel.
 *
 * Every path re-derives ownership and eligibility inside the caller's
 * transaction; the page that showed the form is not a boundary. The PayPal
 * call — create on the first bid, revise afterwards — happens INSIDE the
 * transaction so a provider failure throws and nothing is written.
 *
 * What is confirmed immediately and what waits:
 *
 *   - a first bid, and a raise, are `pending` until PayPal confirms the
 *     quantity behind them (ACTIVATED for a new subscription, UPDATED for a
 *     revision the buyer approved). Until then they hold no position.
 *   - a lowering and a cancellation take effect now: the buyer is choosing to
 *     pay less, and nothing has to be confirmed before they may.
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
 * hold a position among the spot's confirmed bids.
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
    {
      id: "hypothetical",
      listingId,
      amountCents,
      createdAt: spotBidRows.find((b) => b.listingId === listingId)?.createdAt ?? now(),
      status: "active" as const,
    },
  ];
  const mine = rankBids(hypothetical, spot.positions).find((r) => r.listingId === listingId);
  const elsewhere = quantityFor(otherBids.map((b) => ({ amountCents: b.amountCents, status: b.status, position: b.position })));
  return elsewhere + (mine?.position === null || mine === undefined ? 0 : amountCents / 100);
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

  const spot = await ensureSpot(tx, input.viewer, input.spot);
  if (spot.status === "closed") return { outcome: "spot-closed" };

  const bids = await spotBids(tx, input.viewer, spot.id);
  const own = bids.find((b) => b.listingId === listing.id) ?? null;
  const standing = standingFor(spot, bids, listing.id);
  const mine = await listingBids(tx, input.viewer, { listingId: listing.id, profileId: input.profileId });
  const elsewhere = mine.filter((b) => b.spotId !== spot.id);
  const deps = { client: input.client, env: input.env };

  /* ------------------------------------------------------------- lowering */
  if (own !== null && input.amountCents < own.amountCents) {
    const check = validateLower(input.amountCents, spot.floorCents);
    if (!check.ok) return { outcome: "rejected", reason: check.reason, minimum: check.minimum };
    await setBidAmount(tx, input.viewer, { bidId: own.id, amountCents: input.amountCents, ip: input.ip });
    const settled = await settleSpots(tx, [spot.id], deps);
    return { outcome: "applied", approveUrl: approvalFor(settled.changes, listing.id), paths: settled.paths };
  }

  if (own !== null && input.amountCents === own.amountCents && own.pendingAmountCents === null) {
    return { outcome: "unchanged" };
  }

  /* --------------------------------------------------- first bid or raise */
  const check = validateBid(input.amountCents, standing);
  if (!check.ok) return { outcome: "rejected", reason: check.reason, minimum: check.minimum };

  const quantity = projectedQuantity(spot, bids, elsewhere, listing.id, input.amountCents);
  const sub = await currentFeaturedSubscription(tx, input.viewer, listing.id, input.profileId);

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

  // A subscription exists. The bid waits for the confirmation either way;
  // what differs is whether there is anything to ask PayPal for yet.
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

  if (sub.status === "approval_pending" || sub.providerSubscriptionId === null) {
    // The first approval has not happened yet; the bid rides on it. Send
    // the owner back to the same approval page.
    return { outcome: "approval", approveUrl: sub.approveUrl, paths: [] };
  }

  if (input.client.reviseSubscription === undefined) return { outcome: "not-configured" };
  const revised = await input.client.reviseSubscription(sub.providerSubscriptionId, {
    quantity,
    returnUrl: siteUrl(FEATURED_RETURN_PATH),
    cancelUrl: siteUrl(FEATURED_CANCELLED_PATH),
  });
  await updateFeaturedSubscription(
    tx,
    input.viewer,
    sub.id,
    { reviseRequestedAt: now(), approveUrl: revised.approveUrl },
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
  | { readonly outcome: "applied"; readonly approveUrl: string | null; readonly paths: readonly string[] };

/**
 * Cancelling takes effect now. The quantity sync that follows tells PayPal
 * to bill less from the next cycle — or, when nothing featured is left,
 * cancels the subscription so the next cycle is never charged.
 */
export async function cancelOwnBid(tx: TestDb, input: CancelBidInput): Promise<CancelBidOutcome> {
  const listing = await listingForBidding(tx, input.viewer, {
    listingId: input.listingId,
    profileId: input.profileId,
  });
  if (listing === null) return { outcome: "not-owner" };

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
