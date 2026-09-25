import { now } from "@/lib/clock";
import { features } from "@/lib/features/flags";
import type { FeatureMap } from "@/config/types";
import { dueSavedSearches, newMatchesFor } from "@/lib/db/queries/saved-searches";
import { notifySavedSearch } from "@/lib/email/notify";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";
import type { TestDb } from "@/lib/db/types";

/**
 * `alerts.dispatch` (Task 54): hourly, queue a digest for every saved
 * search that is due and has something new.
 *
 * Due is the query's call (daily after 24 h, weekly after 7 d, never-sent at
 * once); "something new" is checked here so the queue only ever holds
 * digests that will send. The worker recomputes the matches when it sends
 * (worker/jobs/notify.ts), so this check decides WHETHER, never WHAT.
 *
 * Flag off: nothing — worker/index.ts does not even schedule it, and this
 * guard is for the test and for anyone calling it by hand. A jobs search on
 * a site whose board is off is left alone rather than switched off: turning
 * the board back on brings its alerts back.
 */

export const ALERTS_DISPATCH_CRON = "23 * * * *";

export async function dispatchAlerts(
  db: Db | TestDb,
  at: Date = now(),
  flags: Pick<FeatureMap, "savedSearches" | "jobBoard"> = features,
): Promise<{ checked: number; queued: number }> {
  if (!flags.savedSearches) return { checked: 0, queued: 0 };
  const tx = db as TestDb;

  let checked = 0;
  let queued = 0;
  for (const search of await dueSavedSearches(tx, at)) {
    if (search.kind === "jobs" && !flags.jobBoard) continue;
    checked++;
    const matches = await newMatchesFor(tx, search, search.lastSeenPublishedAt);
    if (matches.length === 0) continue;
    await notifySavedSearch(tx, ADMIN_VIEWER, search.id, at);
    queued++;
  }
  return { checked, queued };
}
