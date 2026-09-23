import { markAlive } from "@/lib/boot/liveness";
import cron from "node-cron";
import { validateEnv } from "@/config/validate";
import { db, type Db } from "@/lib/db/client";
import { jobRuns } from "@/lib/db/schema";
import { withAdvisoryLock } from "./lock";
import { now } from "@/lib/clock";
import { jobCounts } from "@/lib/db/queries/health";
import { HEARTBEAT_CRON, pushUptime, runHeartbeat } from "@/lib/observability/heartbeat";
import { revalidatePaths } from "@/lib/revalidate/client";
import { features } from "@/lib/features/flags";
import { AWARDS_CRON, awardsCronOptions } from "./jobs/awards";

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
 * What a job may hand back: the ISR paths its writes left stale. They are sent
 * to the web container only after `withAdvisoryLock` has returned, i.e. after
 * the job's transaction has committed — a path marked stale before its write
 * commits is re-cached with the old row (see lib/revalidate/client.ts).
 */
type JobOutcome = void | { readonly revalidate?: readonly string[] };

/**
 * Jobs run inside this container via node-cron, not by system cron hitting HTTP
 * endpoints: that way they get logging, retries and no public attack surface.
 */
/**
 * `options` goes straight to node-cron. The one that matters is `timezone`:
 * an expression is read in the server's clock unless told otherwise, and a
 * job whose meaning is "on 1 January" has to fire on the site's 1 January,
 * not the container's.
 */
function schedule(
  name: string,
  expr: string,
  fn: (tx: Db) => Promise<JobOutcome>,
  options: { timezone?: string } = {},
): void {
  cron.schedule(expr, async () => {
    const startedAt = now();
    try {
      // A plain array, not the outcome itself: TypeScript narrows a union
      // assigned inside a closure to its initialiser, and `never` has no
      // `.revalidate`.
      let paths: readonly string[] = [];
      const ran = await withAdvisoryLock(db, name, async (tx) => {
        paths = (await fn(tx))?.revalidate ?? [];
      });
      const ms = Date.now() - startedAt.getTime();
      console.log(`[worker] ${name} ${ran ? "ok" : "skipped (lock held elsewhere)"} in ${ms}ms`);
      if (ran) {
        await db.insert(jobRuns).values({
          jobName: name, startedAt, finishedAt: now(), status: "ok", lockKey: name,
        });
        // Committed now. Never throws: a failed cache nudge is a stale page,
        // not a failed job.
        if (paths.length > 0) {
          const { sent } = await revalidatePaths(paths);
          console.log(`[worker] ${name} revalidated ${sent}/${paths.length} path(s)`);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[worker] ${name} FAILED:`, message);
      await db.insert(jobRuns).values({
        jobName: name, startedAt, finishedAt: now(), status: "failed", error: message, lockKey: name,
      }).catch(() => {});
    }
  }, options);
  console.log(`[worker] scheduled ${name} (${expr}${options.timezone ? ` ${options.timezone}` : ""})`);
}

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
  markAlive();
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
  return checkBadgeBacklinks(tx);
});

// Badge impressions and clicks live in Redis between flushes, so this is the
// only thing standing between a counter and a lost minute of it.
schedule("badge-counters", "*/1 * * * *", async (tx) => {
  const { flushBadgeCounters } = await import("./jobs/badge-counters");
  await flushBadgeCounters(tx);
});

markAlive();
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
  return syncSubscriptions(tx);
});

// Daily, after the claim-document purge. A finished queue row is a record and
// nothing more; the token it may once have carried was scrubbed when the job
// finished, and a week later the ids go too. See worker/jobs/purge-jobs.ts.
schedule("purge-jobs", "30 3 * * *", async (tx) => {
  const { purgeFinishedJobs } = await import("./jobs/purge-jobs");
  await purgeFinishedJobs(tx);
});

// Daily, after the other two purges. `listing_stats_daily` grows by a row per
// listing per day with traffic and nothing reads past the longest tier window;
// `siteConfig.stats.retentionDays` (validated at build to cover every tier)
// is how long a day's breakdown survives. The lifetime total in
// `listings.view_count` is untouched. See worker/jobs/purge-stats.ts.
schedule("purge-stats", "0 4 * * *", async (tx) => {
  const { purgeStats } = await import("./jobs/purge-stats");
  await purgeStats(tx);
});

// Awards (Task 50). Once a year, in the small hours of 1 January IN THE
// SITE'S TIMEZONE — the same zone the job reads the year in, so a US clone on
// a UTC server decides "Winner 2031" on its own 1 January 2031 and not on the
// evening of 31 December 2030. Only on a site with the module on: a clone
// without it must not accumulate award rows nothing renders. Idempotent, so
// an admin who has already pressed "compute" on /admin/awards for the year
// costs this run nothing. Off the hour like the billing jobs, and after the
// nightly purges have finished.
if (features.awards) {
  schedule("awards", AWARDS_CRON, async (tx) => {
    const { computeAwards } = await import("./jobs/awards");
    const { revalidate } = await computeAwards(tx);
    return { revalidate };
  }, awardsCronOptions());
}
