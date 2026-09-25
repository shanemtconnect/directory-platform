import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import {
  adminQueueCountsInOneQuery, type AdminQueueCounts,
} from "@/lib/db/queries/admin/dashboard";

/**
 * The numbers beside the console's nav links: how much is waiting in each
 * queue, keyed by the link's href so `AdminNav` needs no table of its own.
 *
 * The dashboard already holds the counts and hands them to `navCountsFrom`;
 * every other console page asks `adminNavCounts` for them alongside its own
 * query. A queue with nothing in it is simply absent from the map — a zero
 * beside a link is noise, and the dashboard tiles already say "empty" in words.
 */
export type NavCounts = Readonly<Partial<Record<string, number>>>;

export function navCountsFrom(counts: AdminQueueCounts): NavCounts {
  const pairs: [string, number][] = [
    ["/admin/submissions", counts.pendingSubmissions],
    ["/admin/claims", counts.pendingClaims],
    ["/admin/reviews", counts.reviewsAwaitingModeration],
    ["/admin/cities", counts.citiesAwaitingIntro],
    ["/admin/reports", counts.openReports],
    ["/admin/removals", counts.openRemovals],
    ["/admin/leads", counts.pendingLeadRefunds],
  ];
  return Object.fromEntries(pairs.filter(([, n]) => n > 0));
}

/**
 * One statement, seven sub-selects: every console page calls this beside its
 * own query, so the sequential version cost seven extra round trips per page.
 */
export async function adminNavCounts(tx: TestDb, viewer: Viewer): Promise<NavCounts> {
  return navCountsFrom(await adminQueueCountsInOneQuery(tx, viewer));
}
