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

console.log("[worker] started");
