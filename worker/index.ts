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

// Daily, in the small hours. Retention is a thirty-day promise, not a
// thirty-day-and-five-minutes one, so there is nothing to gain from running it
// more often than once a day — and every run that finds nothing still costs a
// query.
schedule("purge-claim-docs", "0 3 * * *", async (tx) => {
  const { purgeClaimDocuments } = await import("./jobs/purge-claim-docs");
  await purgeClaimDocuments(tx);
});

console.log("[worker] started");
