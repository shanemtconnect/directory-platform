import { getPayPalClient, type PayPalClient } from "@/lib/billing/paypal";
import {
  cancelListingBids,
  featuredSubscriptionsForSync,
  updateFeaturedSubscription,
} from "@/lib/db/queries/spots";
import { reconcileFeaturedSubscription } from "@/lib/spots/webhook";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";
import type { TestDb } from "@/lib/db/types";

/**
 * The hourly backstop for featured-spot billing.
 *
 * Three things a webhook can leave behind, and what this does about each:
 *
 *  - a lapse that never arrived: a row whose paid period ran out past the
 *    grace is asked about, and PayPal's answer applied through the same
 *    transitions the webhook uses — cancelled at PayPal means every bid the
 *    listing holds goes.
 *  - a quantity PayPal has not confirmed: a revise waits for the buyer's
 *    approval, so `quantity` and `requested_quantity` can disagree for a
 *    while. Reconciling re-runs the sync, which re-requests the revision.
 *  - a first approval nobody completed: after a day the pending row is
 *    expired and its pending bids cancelled, so a spot's queue is not held
 *    by a subscription that will never bill.
 *
 * PayPal unreachable changes NOTHING.
 */

const GRACE_DAYS = 3;
const PENDING_HOURS = 24;
const BATCH = 25;

export interface SpotsSyncResult {
  readonly checked: number;
  readonly reconciled: number;
  readonly expired: number;
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
    return { checked: 0, reconciled: 0, expired: 0, skipped: true, revalidate: [] };
  }

  const rows = await featuredSubscriptionsForSync(db, ADMIN_VIEWER, {
    graceDays: GRACE_DAYS,
    pendingHours: PENDING_HOURS,
    limit: BATCH,
  });
  let reconciled = 0;
  let expired = 0;
  const revalidate: string[] = [];

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
    console.log(`[worker] spots-sync checked ${rows.length}, reconciled ${reconciled}, expired ${expired}`);
  }
  return { checked: rows.length, reconciled, expired, revalidate: [...new Set(revalidate)] };
}
