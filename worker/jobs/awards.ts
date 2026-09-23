import { now } from "@/lib/clock";
import { listingPaths } from "@/lib/db/queries/paths";
import {
  awardsCityPath,
  awardYearFor,
  computeAwardsForYear,
  type ComputeAwardsResult,
} from "@/lib/db/queries/awards";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * The yearly awards run (Task 50).
 *
 * Scheduled for the small hours of 1 January and computes the awards for the
 * year that has just begun — "Winner 2031" is decided on 1 January 2031 from
 * the ratings as they stand that morning, and is what a listing carries for
 * the twelve months that follow. The same function is behind the "compute"
 * button on /admin/awards, so a year the cron missed (a worker that was down
 * on New Year's Day) or a clone that launches mid-year can be decided by hand.
 *
 * The method itself lives in `computeAwardsForYear`; this is only the choice
 * of year and the cache paths. Runnable any number of times: the query leaves
 * a decided slot alone, so a re-run is a no-op that reports `skipped`.
 */

/** Re-exported for the tests and the log line; the definition lives with the query module so the admin action shares it. */
export { awardYearFor };

/**
 * Everything a run left stale: the index, the year page, each town page that
 * gained a winner, and each winner's own listing page (the pill and the
 * `award` markup). Deduplicated and in a stable order for the log.
 */
export function awardsRevalidatePaths(
  result: ComputeAwardsResult,
  winnerPaths: readonly string[],
): string[] {
  if (result.created.length === 0) return [];
  const out = new Set<string>(["/awards", `/awards/${result.year}`]);
  for (const c of result.created) out.add(awardsCityPath(result.year, c.citySlug));
  for (const p of winnerPaths) out.add(p);
  return [...out];
}

export interface AwardsRunOutcome {
  result: ComputeAwardsResult;
  revalidate: string[];
}

/** Runs the year's awards. Defaults to the year the clock says it is. */
export async function computeAwards(db: Db, year = awardYearFor(now())): Promise<AwardsRunOutcome> {
  const result = await computeAwardsForYear(db, ADMIN_VIEWER, year);

  // A winner's pill lives on its listing page, and the rating it won with is
  // on its town and category pages too — the same set every other listing
  // change busts.
  const winnerPaths: string[] = [];
  for (const c of result.created) {
    winnerPaths.push(...(await listingPaths(db, ADMIN_VIEWER, c.listingId)));
  }

  const revalidate = awardsRevalidatePaths(result, winnerPaths);
  console.log(
    `[worker] awards ${result.year}: ${result.created.length} awarded, ${result.skipped} already decided`,
  );
  return { result, revalidate };
}
