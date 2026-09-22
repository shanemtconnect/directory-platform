import { eq, sql } from "drizzle-orm";
import { claims, cities, listings, removalRequests, reports } from "@/lib/db/schema";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import { awaitingModeration, countReviewsAwaitingModeration } from "@/lib/db/queries/reviews";
import { reviews } from "@/lib/db/schema";
import type { TestDb } from "@/lib/db/types";

/**
 * The numbers on /admin: what is waiting for somebody.
 *
 * Counts only, never rows. The dashboard's job is to say where the work is, and
 * a page that loaded five lists to show five numbers would be the slowest page
 * on the site for no benefit.
 *
 * The report, removal, claim and review tables are filled by other parts of the
 * console; they are counted here so a queue that quietly fills up is visible
 * from the first page an admin lands on rather than from the table it lives in.
 * The review count is the reviews module's own query, so what the tile says and
 * what the queue shows cannot drift apart.
 */

export interface AdminQueueCounts {
  pendingSubmissions: number;
  openReports: number;
  openRemovals: number;
  /** Published cities with no intro copy — the gate's other half. */
  citiesAwaitingIntro: number;
  pendingClaims: number;
  /** Verified by the reviewer, held by the heuristics, waiting for a human. */
  reviewsAwaitingModeration: number;
}

const TOTAL = sql<number>`count(*)::int`;

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

export async function adminQueueCounts(tx: TestDb, viewer: Viewer): Promise<AdminQueueCounts> {
  assertAdmin(viewer);

  // Sequential rather than Promise.all: these run on the caller's transaction,
  // which is one connection, so parallelism would only queue them anyway.
  const [submissions] = await tx
    .select({ total: TOTAL })
    .from(listings)
    .where(eq(listings.status, "pending"));

  const [openReports] = await tx
    .select({ total: TOTAL })
    .from(reports)
    .where(eq(reports.status, "open"));

  const [openRemovals] = await tx
    .select({ total: TOTAL })
    .from(removalRequests)
    .where(eq(removalRequests.status, "open"));

  const [awaitingIntro] = await tx
    .select({ total: TOTAL })
    .from(cities)
    .where(
      sql`${cities.isPublished} and (${cities.introHtml} is null or btrim(${cities.introHtml}) = '')`,
    );

  const [pendingClaims] = await tx
    .select({ total: TOTAL })
    .from(claims)
    .where(eq(claims.status, "pending"));

  const reviewsAwaitingModeration = await countReviewsAwaitingModeration(tx, viewer);

  return {
    pendingSubmissions: submissions?.total ?? 0,
    openReports: openReports?.total ?? 0,
    openRemovals: openRemovals?.total ?? 0,
    citiesAwaitingIntro: awaitingIntro?.total ?? 0,
    pendingClaims: pendingClaims?.total ?? 0,
    reviewsAwaitingModeration,
  };
}

/**
 * The same six numbers in one round trip.
 *
 * `adminQueueCounts` runs six statements in sequence, and every console page
 * asks for them beside its own query — so a page that needs one list was
 * paying for seven round trips. Six scalar sub-selects in one statement cost
 * the same work in Postgres and one trip on the wire. The predicates are the
 * same as above, and the review one is the reviews module's own, so the nav
 * badge and the tile cannot disagree.
 */
export async function adminQueueCountsInOneQuery(
  tx: TestDb,
  viewer: Viewer,
): Promise<AdminQueueCounts> {
  assertAdmin(viewer);

  const rows = await tx.execute<Record<string, unknown>>(sql`
    select
      (select count(*)::int from ${listings} where ${listings.status} = 'pending')
        as pending_submissions,
      (select count(*)::int from ${reports} where ${reports.status} = 'open')
        as open_reports,
      (select count(*)::int from ${removalRequests} where ${removalRequests.status} = 'open')
        as open_removals,
      (select count(*)::int from ${cities}
        where ${cities.isPublished} and (${cities.introHtml} is null or btrim(${cities.introHtml}) = ''))
        as cities_awaiting_intro,
      (select count(*)::int from ${claims} where ${claims.status} = 'pending')
        as pending_claims,
      (select count(*)::int from ${reviews} where ${awaitingModeration()})
        as reviews_awaiting_moderation
  `);
  const row = rows[0] ?? {};
  const n = (key: string): number => {
    const value = row[key];
    return typeof value === "number" ? value : Number(value ?? 0);
  };
  return {
    pendingSubmissions: n("pending_submissions"),
    openReports: n("open_reports"),
    openRemovals: n("open_removals"),
    citiesAwaitingIntro: n("cities_awaiting_intro"),
    pendingClaims: n("pending_claims"),
    reviewsAwaitingModeration: n("reviews_awaiting_moderation"),
  };
}
