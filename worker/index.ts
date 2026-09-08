import cron from "node-cron";
import { db, type Db } from "@/lib/db/client";
import { jobRuns } from "@/lib/db/schema";
import { withAdvisoryLock } from "./lock";
import { now } from "@/lib/clock";

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

console.log("[worker] started");
