import { now } from "@/lib/clock";
import { getPayPalClient, type PayPalClient } from "@/lib/billing/paypal";
import {
  cancelListingBids,
  expirePendingBids,
  featuredSubscriptionsForSync,
  updateFeaturedSubscription,
  type FeaturedSubscription,
} from "@/lib/db/queries/spots";
import { settleSpots } from "@/lib/spots/engine";
import { reconcileFeaturedSubscription } from "@/lib/spots/webhook";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";
import type { TestDb } from "@/lib/db/types";

/**
 * The hourly backstop for featured-spot billing.
 *
 * What a webhook can leave behind, and what this does about each:
 *
 *  - a lapse that never arrived: a row whose paid period ran out past the
 *    grace is asked about, and PayPal's answer applied through the same
 *    transitions the webhook uses — cancelled at PayPal means every bid the
 *    listing holds goes.
 *  - a quantity PayPal has not confirmed: a revise waits for the buyer's
 *    approval, so `quantity` and `requested_quantity` can disagree for a
 *    while. Reconciling applies whatever the GET shows; the settle that
 *    follows re-requests the revision.
 *  - an unapproved raise or pending bid on a live subscription, a day old:
 *    the raise is dropped and the pending bid cancelled (audit rows the
 *    owner page reads), and the quantity re-settled (I6).
 *  - a first approval nobody completed: after a day the pending row is
 *    expired and its pending bids cancelled.
 *  - a subscription paused for a whole cycle (every bid outbid, nothing
 *    resumed): cancelled at PayPal and its bids with it (I5).
 *
 * PayPal unreachable changes NOTHING.
 */

const GRACE_DAYS = 3;
const PENDING_HOURS = 24;
const PAUSED_DAYS = 31;
const BATCH = 25;

export interface SpotsSyncResult {
  readonly checked: number;
  readonly reconciled: number;
  readonly expired: number;
  readonly cancelled: number;
  readonly skipped?: boolean;
  readonly revalidate: string[];
}

export async function syncFeaturedSubscriptions(
  db: Db,
  opts: { client?: PayPalClient | null; env?: Record<string, string | undefined> } = {},
): Promise<SpotsSyncResult> {
  const client = opts.client === undefined ? getPayPalClient() : opts.client;
  if (client === null) {
    console.log("[worker] spots-sync skipped — PayPal is not configured");
    return { checked: 0, reconciled: 0, expired: 0, cancelled: 0, skipped: true, revalidate: [] };
  }

  const rows = await featuredSubscriptionsForSync(db, ADMIN_VIEWER, {
    graceDays: GRACE_DAYS,
    pendingHours: PENDING_HOURS,
    pausedDays: PAUSED_DAYS,
    limit: BATCH,
  });
  let reconciled = 0;
  let expired = 0;
  let cancelled = 0;
  const revalidate: string[] = [];
  const deps = { client, env: opts.env };

  for (const row of rows) {
    if (row.providerSubscriptionId === null) continue;
    const providerSubscriptionId = row.providerSubscriptionId;

    if (row.status === "approval_pending") {
      let view;
      try {
        view = await client.getSubscription(providerSubscriptionId);
      } catch (e) {
        console.error(`[worker] could not check ${providerSubscriptionId}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (view === null || view.status === "APPROVAL_PENDING") {
        // Never approved. Nothing was ever charged; nothing is owed.
        await db.transaction(async (sp) => {
          const tx = sp as unknown as TestDb;
          await updateFeaturedSubscription(
            tx,
            ADMIN_VIEWER,
            row.id,
            { status: "expired", approveUrl: null },
            { action: "spots.expired", meta: { listingId: row.listingId, reason: "never-approved" } },
          );
          await cancelListingBids(tx, ADMIN_VIEWER, row.listingId, { reason: "never-approved" });
        });
        expired++;
        continue;
      }
    }

    if (row.status === "paused") {
      // A whole cycle with nothing featured. Cancel, and let the bids go.
      try {
        await client.cancelSubscription(providerSubscriptionId, "Paused for a full billing cycle");
      } catch (e) {
        console.error(`[worker] could not cancel ${providerSubscriptionId}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const paths = await db.transaction(async (sp) => {
        const tx = sp as unknown as TestDb;
        await updateFeaturedSubscription(
          tx,
          ADMIN_VIEWER,
          row.id,
          { status: "cancelled", pausedAt: null, approveUrl: null, reviseRequestedAt: null },
          { action: "spots.subscription_cancelled", meta: { listingId: row.listingId, reason: "paused-full-cycle" } },
        );
        const spots = await cancelListingBids(tx, ADMIN_VIEWER, row.listingId, { reason: "paused-full-cycle" });
        return (await settleSpots(tx, spots, deps)).paths;
      });
      revalidate.push(...paths);
      cancelled++;
      continue;
    }

    if (stalePending(row)) {
      const paths = await db.transaction(async (sp) => {
        const tx = sp as unknown as TestDb;
        const spots = await expirePendingBids(tx, ADMIN_VIEWER, row.listingId, { reason: "not-approved-in-time" });
        await updateFeaturedSubscription(
          tx,
          ADMIN_VIEWER,
          row.id,
          { reviseRequestedAt: null, approveUrl: null },
          { action: "spots.revise_expired", meta: { listingId: row.listingId } },
        );
        // Re-settle: the quantity the bids still need may differ from what
        // PayPal bills, and the revise-down is asked for again.
        return (await settleSpots(tx, spots, deps, [row.listingId])).paths;
      });
      revalidate.push(...paths);
      expired++;
    }

    // A savepoint each: one row whose write fails must not roll back the
    // ones already reconciled in this tick.
    const outcome = await db.transaction(async (sp) =>
      reconcileFeaturedSubscription(sp as unknown as TestDb, {
        client,
        env: opts.env,
        providerSubscriptionId,
      }),
    );
    if (outcome.outcome === "applied") {
      reconciled++;
      revalidate.push(...outcome.paths);
    } else if (outcome.outcome === "provider-error") {
      console.error(`[worker] could not reconcile ${providerSubscriptionId}: ${outcome.message}`);
    }
  }

  if (rows.length > 0) {
    console.log(
      `[worker] spots-sync checked ${rows.length}, reconciled ${reconciled}, expired ${expired}, cancelled ${cancelled}`,
    );
  }
  return { checked: rows.length, reconciled, expired, cancelled, revalidate: [...new Set(revalidate)] };
}

/** A revise asked more than PENDING_HOURS ago and still unanswered. */
function stalePending(row: FeaturedSubscription): boolean {
  if (row.status !== "active" && row.status !== "past_due") return false;
  if (row.reviseRequestedAt === null) return false;
  return now().getTime() - row.reviseRequestedAt.getTime() >= PENDING_HOURS * 3_600_000;
}
