import { siteConfig } from "@/config/site.config";
import { MIN_STATS_RETENTION_DAYS } from "@/config/validate";
import { purgeStatsBefore } from "@/lib/db/queries/stats";
import { dayRange } from "@/lib/stats/keys";
import { now } from "@/lib/clock";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * Deletes `listing_stats_daily` rows older than `siteConfig.stats.retentionDays`.
 *
 * The table grows by one row per listing per day with traffic — nothing at 200
 * listings, eighteen million rows a year at fifty thousand — and nothing reads
 * past the longest tier window. `listings.view_count` keeps the lifetime total,
 * so a purged day is not a lost view, only a lost breakdown.
 *
 * The cutoff comes from `now()` and `dayRange`, in the site's timezone, so the
 * window can be tested by moving the clock, and so "400 days" means the same
 * 400 calendar days the owner panel counts.
 */

/**
 * The oldest day kept: `retentionDays` calendar days ending today, inclusive.
 * Clamped to the floor the build validates, so a config that somehow got past
 * it (a clone edited by hand after scaffolding) still cannot purge the free
 * tier's window.
 */
export function statsCutoffDay(retentionDays: number): string {
  const days = Number.isFinite(retentionDays)
    ? Math.max(MIN_STATS_RETENTION_DAYS, Math.floor(retentionDays))
    : MIN_STATS_RETENTION_DAYS;
  return dayRange(now(), days)[0]!;
}

/** Returns how many rows went, for the worker's log line. */
export async function purgeStats(db: Db): Promise<number> {
  const retentionDays = siteConfig.stats.retentionDays;
  const cutoff = statsCutoffDay(retentionDays);
  const gone = await purgeStatsBefore(db, ADMIN_VIEWER, cutoff);
  if (gone > 0) {
    console.log(
      `[worker] purged ${gone} listing_stats_daily row(s) before ${cutoff} ` +
        `(${retentionDays}-day retention)`,
    );
  }
  return gone;
}
