import cron from "node-cron";
import { validateEnv } from "@/config/validate";
import { db, type Db } from "@/lib/db/client";
import { jobRuns } from "@/lib/db/schema";
import { withAdvisoryLock } from "./lock";
import { now } from "@/lib/clock";

// The worker has no health check and no requests to fail loudly, so a missing
// key would otherwise show up as jobs that quietly never run. (DATABASE_URL is
// the exception: `@/lib/db/client` throws its own message at import time, which
// under ES module evaluation order happens before this line.)
try {
  validateEnv(process.env, { phase: "runtime" });
} catch (e) {
  // Exit rather than let the throw propagate, for the same reason
  // `instrumentation.ts` does: an unhandled rejection at module scope does not
  // reliably stop a Node process, and a worker that is "up" but never runs a
  // job is invisible. `process.exit` is not.
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

if (process.env.WORKER_ENABLED !== "true") {
  console.log("[worker] WORKER_ENABLED is not 'true' — exiting");
  process.exit(0);
}

/**
 * Jobs run inside this container via node-cron, not by system cron hitting HTTP
 * endpoints: that way they get logging, retries and no public attack surface.
 */
function schedule(name: string, expr: string, fn: (tx: Db) => Promise<void>): void {
  cron.schedule(expr, async () => {
    const startedAt = now();
    try {
      const ran = await withAdvisoryLock(db, name, fn);
      const ms = Date.now() - startedAt.getTime();
      console.log(`[worker] ${name} ${ran ? "ok" : "skipped (lock held elsewhere)"} in ${ms}ms`);
      if (ran) {
        await db.insert(jobRuns).values({
          jobName: name, startedAt, finishedAt: now(), status: "ok", lockKey: name,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[worker] ${name} FAILED:`, message);
      await db.insert(jobRuns).values({
        jobName: name, startedAt, finishedAt: now(), status: "failed", error: message, lockKey: name,
      }).catch(() => {});
    }
  });
  console.log(`[worker] scheduled ${name} (${expr})`);
}

// Phase 1 ships the image pipeline. Later phases add:
//   Phase 3 — city indexing gate
//   Phase 4 — claim-document purge (30 days after decision)
//   Phase 5 — verification expiry and renewal reminders at 30/7/0 days
//   Phase 6 — backlink verification
schedule("derivatives", "*/1 * * * *", async (tx) => {
  const { processPendingDerivatives } = await import("./jobs/derivatives");
  await processPendingDerivatives(tx);
});

// Every 30 seconds (six fields — the first is seconds). An enquiry notification
// is the lead a paying listing bought; a minute of latency on it is noticed.
schedule("notify", "*/30 * * * * *", async (tx) => {
  const { processNotifications } = await import("./jobs/notify");
  await processNotifications(tx);
});

console.log("[worker] started");

/**
 * Phase 5, billing.
 *
 * Both are hourly and both are no-ops on a site without PayPal credentials —
 * the sync job says so in its log line and the reminder job simply finds
 * nothing, because a site with no subscriptions has no renewals.
 *
 * Offset minutes, not on the hour: they share a database with everything else
 * that ticks, and three jobs starting at :00 together is a thundering herd for
 * no reason.
 */
schedule("renewal-reminders", "17 * * * *", async (tx) => {
  const { runRenewalReminders } = await import("./jobs/renewal-reminders");
  await runRenewalReminders(tx);
});

schedule("subscription-sync", "37 * * * *", async (tx) => {
  const { syncSubscriptions } = await import("./jobs/subscription-sync");
  await syncSubscriptions(tx);
});
