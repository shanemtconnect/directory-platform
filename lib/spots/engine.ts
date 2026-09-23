import { siteUrl } from "@/lib/schema/builders";
import { now } from "@/lib/clock";
import type { PayPalClient } from "@/lib/billing/paypal";
import {
  applyRanking,
  cancelListingBids,
  chargeableBidsForListing,
  currentFeaturedSubscription,
  hasPendingBids,
  listingsInSpots,
  spotBids,
  spotById,
  spotPaths,
  updateFeaturedSubscription,
} from "@/lib/db/queries/spots";
import type { TestDb } from "@/lib/db/types";
import type { Viewer } from "@/lib/db/viewer";
import { quantityFor, rankBids } from "./rank";

/**
 * The two things that happen after ANY bid changes, in this order:
 *
 *   1. `rerankSpots` — every spot the change touched is ranked again from its
 *      confirmed bids and the positions written back.
 *   2. `syncQuantities` — every listing with a bid in those spots has its
 *      PayPal quantity recomputed from what it now holds, and PayPal is told
 *      when that differs from what it is billing.
 *
 * Both run as the system: the owner who lowered a bid is not the owner whose
 * listing just moved up because of it, and the quantity that changes is
 * theirs. Everything the caller needs afterwards — the ISR paths to bust and
 * any approval link to send the owner to — comes back in the result.
 */

/**
 * Same authority as `BILLING_SYSTEM_VIEWER` in lib/billing/process.ts —
 * declared again rather than imported because process.ts imports this
 * module's caller (lib/spots/webhook.ts), and a cycle leaves the constant
 * undefined at load. The nil UUID can never match a row's owner_id.
 */
export const SPOTS_SYSTEM_VIEWER: Viewer = {
  role: "admin",
  userId: "00000000-0000-0000-0000-000000000000",
};

export const FEATURED_RETURN_PATH = "/account/featured/return";
export const FEATURED_CANCELLED_PATH = "/account/featured/cancelled";

export interface RerankResult {
  readonly listingIds: string[];
  readonly paths: string[];
}

export async function rerankSpots(tx: TestDb, spotIds: readonly string[]): Promise<RerankResult> {
  const viewer = SPOTS_SYSTEM_VIEWER;
  const paths = new Set<string>();
  const unique = [...new Set(spotIds)];
  for (const spotId of unique) {
    const spot = await spotById(tx, viewer, spotId);
    if (spot === null) continue;
    const bids = await spotBids(tx, viewer, spotId);
    await applyRanking(tx, viewer, spotId, rankBids(bids, spot.positions));
    for (const path of await spotPaths(tx, viewer, spotId)) paths.add(path);
  }
  return { listingIds: await listingsInSpots(tx, viewer, unique), paths: [...paths] };
}

export interface BillingDeps {
  readonly client: PayPalClient | null;
  readonly env?: Record<string, string | undefined>;
}

export type QuantityAction = "none" | "revised" | "cancelled" | "not-configured" | "awaiting-approval";

export interface QuantityChange {
  readonly listingId: string;
  readonly subscriptionId: string;
  readonly quantity: number;
  readonly action: QuantityAction;
  /** Where the owner approves the revision, when PayPal asked for one. */
  readonly approveUrl: string | null;
}

/**
 * THE invariant, applied: for each listing, quantity = the sum of its bids
 * that are active AND hold a position. A listing left with nothing featured
 * and nothing pending has its subscription cancelled outright — PayPal offers
 * no consent-free way to bill zero and resume later — and its remaining
 * (outbid) bids go with it; the owner bids again to come back.
 *
 * A revise needs the buyer's approval (see lib/billing/featured-plan.ts).
 * It is requested here and noted on the row; `spots-sync` re-requests it
 * until PayPal's confirmed quantity agrees with the requested one.
 */
export async function syncQuantities(
  tx: TestDb,
  listingIds: readonly string[],
  deps: BillingDeps,
): Promise<QuantityChange[]> {
  const viewer = SPOTS_SYSTEM_VIEWER;
  const out: QuantityChange[] = [];

  for (const listingId of new Set(listingIds)) {
    const sub = await currentFeaturedSubscription(tx, viewer, listingId);
    if (sub === null) continue;

    const quantity = quantityFor(await chargeableBidsForListing(tx, viewer, listingId));
    const pending = await hasPendingBids(tx, viewer, listingId);

    if (quantity !== sub.requestedQuantity) {
      await updateFeaturedSubscription(
        tx,
        viewer,
        sub.id,
        { requestedQuantity: quantity },
        { action: "spots.quantity_requested", meta: { listingId, was: sub.requestedQuantity } },
      );
    }

    // Nothing to tell PayPal until the buyer has approved the subscription
    // at all; the first ACTIVATED brings the confirmed quantity and the
    // sync catches any drift from there.
    if (sub.status === "approval_pending" || sub.providerSubscriptionId === null) {
      out.push({ listingId, subscriptionId: sub.id, quantity, action: "awaiting-approval", approveUrl: sub.approveUrl });
      continue;
    }

    if (quantity === 0 && !pending) {
      if (deps.client === null) {
        out.push({ listingId, subscriptionId: sub.id, quantity, action: "not-configured", approveUrl: null });
        continue;
      }
      // Cancel at PayPal FIRST; a PayPal failure throws and the caller's
      // transaction rolls back with it.
      await deps.client.cancelSubscription(sub.providerSubscriptionId, "No featured positions held");
      await updateFeaturedSubscription(
        tx,
        viewer,
        sub.id,
        { status: "cancelled", requestedQuantity: 0, reviseRequestedAt: null, approveUrl: null },
        { action: "spots.subscription_cancelled", meta: { listingId, reason: "nothing-featured" } },
      );
      await cancelListingBids(tx, viewer, listingId, { reason: "nothing-featured" });
      out.push({ listingId, subscriptionId: sub.id, quantity, action: "cancelled", approveUrl: null });
      continue;
    }

    if (quantity === sub.quantity || quantity === 0) {
      out.push({ listingId, subscriptionId: sub.id, quantity, action: "none", approveUrl: null });
      continue;
    }

    if (deps.client === null || deps.client.reviseSubscription === undefined) {
      out.push({ listingId, subscriptionId: sub.id, quantity, action: "not-configured", approveUrl: null });
      continue;
    }
    const revised = await deps.client.reviseSubscription(sub.providerSubscriptionId, {
      quantity,
      returnUrl: siteUrl(FEATURED_RETURN_PATH),
      cancelUrl: siteUrl(FEATURED_CANCELLED_PATH),
    });
    await updateFeaturedSubscription(
      tx,
      viewer,
      sub.id,
      { reviseRequestedAt: now(), approveUrl: revised.approveUrl },
      { action: "spots.revise_requested", meta: { listingId, quantity, was: sub.quantity } },
    );
    out.push({ listingId, subscriptionId: sub.id, quantity, action: "revised", approveUrl: revised.approveUrl });
  }
  return out;
}

export interface SettleResult extends RerankResult {
  readonly changes: QuantityChange[];
}

/** Re-rank, then re-bill: the pair every mutation ends with. */
export async function settleSpots(
  tx: TestDb,
  spotIds: readonly string[],
  deps: BillingDeps,
  /** Listings to re-bill even if they no longer hold a bid in these spots — the one that just cancelled. */
  alsoListingIds: readonly string[] = [],
): Promise<SettleResult> {
  const ranked = await rerankSpots(tx, spotIds);
  const changes = await syncQuantities(tx, [...ranked.listingIds, ...alsoListingIds], deps);
  return { ...ranked, changes };
}
