import { reconcileSubscription } from "@/lib/billing/subscriptions";
import { staleActiveSubscriptions } from "@/lib/db/queries/billing";
import { getPayPalClient, type PayPalClient } from "@/lib/billing/paypal";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * The backstop for a webhook that never arrived.
 *
 * Every date on a subscription comes in by webhook. If one is missed — the
 * endpoint was down, PayPal exhausted its retries, or PAYPAL_WEBHOOK_ID was
 * unset so every delivery was rejected as unverifiable — then
 * `current_period_end` stops moving and a customer who has paid for the year
 * quietly drops to the free tier. Nobody complains about that, because from
 * the outside it looks deliberate.
 *
 * So once an hour, any row whose paid period ran out more than a few days ago
 * is checked against PayPal itself. The direction of failure is the important
 * part: PayPal unreachable changes NOTHING. A network error must never hand
 * out a year of a paid tier, and it must never take one away either.
 */

/**
 * Three days. Long enough to cover a late delivery and PayPal's own retry
 * schedule; short enough that a genuinely lapsed listing is not ranked above
 * paying ones for a week.
 */
const GRACE_DAYS = 3;

/** A tick's worth. The next tick takes the rest. */
const BATCH = 25;

export interface SyncResult {
  readonly checked: number;
  readonly reconciled: number;
  readonly skipped?: boolean;
}

export async function syncSubscriptions(
  db: Db,
  opts: { client?: PayPalClient | null; env?: Record<string, string | undefined> } = {},
): Promise<SyncResult> {
  const client = opts.client === undefined ? getPayPalClient() : opts.client;
  if (client === null) {
    // Not an error: a site without billing credentials has nothing to sync.
    console.log("[worker] subscription-sync skipped — PayPal is not configured");
    return { checked: 0, reconciled: 0, skipped: true };
  }

  const stale = await staleActiveSubscriptions(db, ADMIN_VIEWER, {
    graceDays: GRACE_DAYS,
    limit: BATCH,
  });
  let reconciled = 0;

  for (const row of stale) {
    // A savepoint each: one subscription whose write fails must not roll back
    // the ones already reconciled in this tick.
    const outcome = await db.transaction(async (sp) =>
      reconcileSubscription(sp as unknown as Db, {
        client,
        env: opts.env,
        providerSubscriptionId: row.providerSubscriptionId,
      }),
    );
    if (outcome.outcome === "applied") reconciled++;
    else if (outcome.outcome === "provider-error") {
      console.error(`[worker] could not reconcile ${row.providerSubscriptionId}: ${outcome.message}`);
    }
  }

  if (stale.length > 0) {
    console.log(`[worker] subscription-sync checked ${stale.length}, reconciled ${reconciled}`);
  }
  return { checked: stale.length, reconciled };
}
