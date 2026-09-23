import { siteUrl } from "@/lib/schema/builders";
import { now } from "@/lib/clock";
import type { PayPalClient } from "@/lib/billing/paypal";
import {
  applyRanking,
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
import { notifyOutbid } from "./notify";

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
    const ranked = rankBids(bids, spot.positions);
    await applyRanking(tx, viewer, spotId, ranked);
    // Task 45: the owners who lost ground hear about it (debounced).
    await notifyOutbid(tx, spotId, bids, ranked);
    for (const path of await spotPaths(tx, viewer, spotId)) paths.add(path);
  }
  return { listingIds: await listingsInSpots(tx, viewer, unique), paths: [...paths] };
}

export interface BillingDeps {
  readonly client: PayPalClient | null;
  readonly env?: Record<string, string | undefined>;
}

export type QuantityAction =
  | "none"
  | "revised"
  | "paused"
  | "resumed"
  | "not-configured"
  | "awaiting-approval";

export interface QuantityChange {
  readonly listingId: string;
  readonly subscriptionId: string;
  readonly quantity: number;
  readonly action: QuantityAction;
  /** Where the owner approves the revision, when PayPal asked for one. */
  readonly approveUrl: string | null;
}

/**
 * THE invariant, applied: for each listing, the quantity PayPal is asked
 * for = the sum of its bids that are active AND hold a position.
 *
 *  - Nothing featured and nothing pending: the subscription is SUSPENDED at
 *    PayPal (no consent needed) and the row is `paused`; the outbid bids stay
 *    in the queue. When one re-enters, the subscription is ACTIVATED again —
 *    no new approval, no fresh first cycle — and revised only if the amount
 *    differs from what was consented to. `spots-sync` cancels a subscription
 *    that has been paused for a whole cycle.
 *  - A revise needs the buyer's approval (lib/billing/featured-plan.ts). It
 *    is requested here, `requested_quantity` records what was asked, and the
 *    sync re-requests it until PayPal's confirmed quantity agrees.
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
    const push = (action: QuantityAction, approveUrl: string | null = null) =>
      out.push({ listingId, subscriptionId: sub.id, quantity, action, approveUrl });

    // Nothing to tell PayPal until the buyer has approved the subscription
    // at all; the first ACTIVATED brings the confirmed quantity.
    if (sub.status === "approval_pending" || sub.providerSubscriptionId === null) {
      push("awaiting-approval", sub.approveUrl);
      continue;
    }
    const providerId = sub.providerSubscriptionId;

    if (quantity === 0 && !pending) {
      if (sub.status === "paused") {
        push("none");
        continue;
      }
      if (deps.client?.suspendSubscription === undefined) {
        push("not-configured");
        continue;
      }
      // PayPal FIRST; a failure throws and the caller's transaction rolls back.
      await deps.client.suspendSubscription(providerId, "No featured positions held");
      await updateFeaturedSubscription(
        tx,
        viewer,
        sub.id,
        { status: "paused", pausedAt: now(), reviseRequestedAt: null, approveUrl: null },
        { action: "spots.paused", meta: { listingId, reason: "nothing-featured" } },
      );
      push("paused");
      continue;
    }

    let status = sub.status;
    if (status === "paused" && quantity > 0) {
      if (deps.client?.activateSubscription === undefined) {
        push("not-configured");
        continue;
      }
      await deps.client.activateSubscription(providerId, "A featured position was regained");
      await updateFeaturedSubscription(
        tx,
        viewer,
        sub.id,
        { status: "active", pausedAt: null },
        { action: "spots.resumed", meta: { listingId, quantity } },
      );
      status = "active";
      if (quantity === sub.quantity) {
        push("resumed");
        continue;
      }
    }

    // A raise or a new bid is waiting for the click on a revise already
    // asked for: do not ask for a different quantity underneath it. The
    // sync expires it after a day if the click never comes.
    if (pending && sub.reviseRequestedAt !== null && sub.approveUrl !== null) {
      push("awaiting-approval", sub.approveUrl);
      continue;
    }

    if (quantity === sub.quantity || quantity === 0) {
      if (!pending && (sub.approveUrl !== null || sub.reviseRequestedAt !== null || sub.requestedQuantity !== quantity)) {
        // Whatever was outstanding is moot: PayPal already bills this amount.
        await updateFeaturedSubscription(
          tx,
          viewer,
          sub.id,
          { requestedQuantity: quantity, reviseRequestedAt: null, approveUrl: null },
          { action: "spots.revise_settled", meta: { listingId, quantity } },
        );
      }
      push("none");
      continue;
    }

    if (deps.client?.reviseSubscription === undefined) {
      push("not-configured");
      continue;
    }
    if (sub.requestedQuantity === quantity && sub.reviseRequestedAt !== null && sub.approveUrl !== null) {
      // Already asked, still waiting for the click. Do not ask twice.
      push("awaiting-approval", sub.approveUrl);
      continue;
    }
    const revised = await deps.client.reviseSubscription(providerId, {
      quantity,
      returnUrl: siteUrl(FEATURED_RETURN_PATH),
      cancelUrl: siteUrl(FEATURED_CANCELLED_PATH),
    });
    await updateFeaturedSubscription(
      tx,
      viewer,
      sub.id,
      { requestedQuantity: quantity, reviseRequestedAt: now(), approveUrl: revised.approveUrl },
      { action: "spots.revise_requested", meta: { listingId, quantity, was: sub.quantity } },
    );
    push("revised", revised.approveUrl);
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
