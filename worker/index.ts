import cron from "node-cron";
import { validateEnv } from "@/config/validate";
import { db, type Db } from "@/lib/db/client";
import { jobRuns } from "@/lib/db/schema";
import { withAdvisoryLock } from "./lock";
import { now } from "@/lib/clock";
import { jobCounts } from "@/lib/db/queries/health";
import { HEARTBEAT_CRON, pushUptime, runHeartbeat } from "@/lib/observability/heartbeat";

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

/**
 * Proof of life, every five minutes.
 *
 * NOT via `schedule()` above, for two reasons. It would take the advisory lock,
 * so a second worker's heartbeat would report "skipped" — and a heartbeat that
 * goes quiet because another process holds a lock is a heartbeat that lies
 * about the thing it exists to prove. It would also write a `job_runs` row per
 * beat, inflating the very counts it reports.
 *
 * The web container has `/api/health` for this; the worker listens on no port,
 * so a pull check cannot reach it and its absence is the only available signal.
 * `UPTIME_PUSH_URL` (optional) forwards each beat to a push monitor — see the
 * README's Monitoring section for the interval to set on it.
 */
cron.schedule(HEARTBEAT_CRON, async () => {
  const result = await runHeartbeat({
    counts: (since) => jobCounts(db, since),
    log: (line) => console.log(`[worker] ${line}`),
    error: (line) => console.error(`[worker] ${line}`),
    push: (message) => pushUptime(message),
    nowMs: Date.now,
  });
  if (result === "failed") console.warn("[worker] uptime push failed");
});
console.log(`[worker] scheduled heartbeat (${HEARTBEAT_CRON})`);
// Every five minutes. The counters live in Redis so a page view is never a
// database write; this is the only thing that turns them into the owner's ROI
// numbers, and it is also what stops Redis carrying a key per listing per day.
schedule("flush-stats", "*/5 * * * *", async (tx) => {
  const { flushStats } = await import("./jobs/flush-stats");
  await flushStats(tx);
});

// Daily, in the small hours. Retention is a thirty-day promise, not a
// thirty-day-and-five-minutes one, so there is nothing to gain from running it
// more often than once a day — and every run that finds nothing still costs a
// query.
schedule("purge-claim-docs", "0 3 * * *", async (tx) => {
  const { purgeClaimDocuments } = await import("./jobs/purge-claim-docs");
  await purgeClaimDocuments(tx);
});

// Phase 6. Hourly rather than daily: the query decides what is DUE (weekly for
// a verified link, daily for one we have never seen work), so running often
// only spreads the fetches out — it never re-checks anything early.
schedule("backlink-check", "0 * * * *", async (tx) => {
  const { checkBadgeBacklinks } = await import("./jobs/backlink-check");
  await checkBadgeBacklinks(tx);
});

// Badge impressions and clicks live in Redis between flushes, so this is the
// only thing standing between a counter and a lost minute of it.
schedule("badge-counters", "*/1 * * * *", async (tx) => {
  const { flushBadgeCounters } = await import("./jobs/badge-counters");
  await flushBadgeCounters(tx);
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
