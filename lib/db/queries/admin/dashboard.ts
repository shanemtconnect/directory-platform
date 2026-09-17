import { eq, sql } from "drizzle-orm";
import { claims, cities, listings, removalRequests, reports } from "@/lib/db/schema";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import { countReviewsAwaitingModeration } from "@/lib/db/queries/reviews";
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
