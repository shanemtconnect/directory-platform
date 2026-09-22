import { and, eq, sql } from "drizzle-orm";
import { cities, listings, slugs } from "@/lib/db/schema";
import { isAdmin, PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { countListings, PER_PAGE } from "./listings";
import { regionPaths } from "./areas";

/**
 * The ISR pages a change to one listing can leave stale.
 *
 * The listing page itself, its reviews page (same header, same tier gating on
 * the website and socials), the city pillar — where tier decides the featured
 * row and the sort order — every paginated page of that pillar that currently
 * exists, and the category's pillar page inside the city when the category is
 * routed there. The paginated pages are the ones people forget: a listing
 * approved into a city with 30 published entries lands on `/city/page/2` as
 * readily as on `/city`, and a removal that shrinks the count from 25 to 24
 * has to bring `/city/page/2` down, not just re-render it.
 *
 * Every admin decision that changes what a visitor sees (approve, reject,
 * takedown, review moderation, claim approval) goes through this, as do the
 * worker's tier and backlink_boost writes — one list, one place to get it
 * right. The worker hands the paths to `lib/revalidate/client.ts` once its
 * transaction has committed (see the comment there for why "once committed"
 * matters); the server actions call `revalidatePath` on each.
 *
 * Callers that SHRINK the count — a takedown, a rejection of something that
 * was published — must call this BEFORE the change, on the same handle:
 * afterwards the last page no longer exists in the count and its cached copy
 * is exactly the one that needs to go.
 *
 * No published-only filter on the listing itself, on purpose. A listing that
 * has just lapsed or been removed is precisely the one whose cached page is
 * now wrong, and revalidating a path that 404s costs nothing. The page COUNT
 * is published-only, because that is what the public route paginates.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/city/page/2` … `/city/page/N` for a city with `published` listings. Never page 1: that is `/city`. */
export function paginatedCityPaths(citySlug: string, published: number): string[] {
  const pages = Math.ceil(published / PER_PAGE);
  const out: string[] = [];
  for (let n = 2; n <= pages; n++) out.push(`/${citySlug}/page/${n}`);
  return out;
}

export async function listingPaths(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<string[]> {
  // Slugs are public, but the count and the join are work only an admin
  // decision or the worker has a reason to ask for.
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
  return resolveListingPaths(tx, listingId);
}

/**
 * The same list, with no viewer gate.
 *
 * For query functions that have ALREADY proved the caller's right to change
 * this listing inside the same transaction — the owner's profile matched
 * `listings.owner_id` (`updateOwnerListing`, `createReviewReply`), the token
 * matched a row (`verifyReviewToken`, `verifyClaimToken`), or the billing
 * viewer applied what PayPal reported (`applyEffect`) — and return the paths
 * as part of their result so the action or route that called them busts
 * exactly what `listingPaths` would have. That is what keeps "one helper,
 * every caller" true for the callers that do not run as an admin.
 *
 * Actions and routes take `listingPaths`, never this. The gate up there is a
 * cost guard, not a data guard (every slug here is public), but it is the
 * one place that decides who may ask a count and a join of a listing, and
 * request-path code importing this would be deciding for itself.
 */
export async function resolveListingPaths(tx: TestDb, listingId: string): Promise<string[]> {
  if (!UUID.test(listingId)) return [];

  const [row] = await tx
    .select({
      slug: listings.slug,
      cityId: listings.cityId,
      citySlug: cities.slug,
      region: cities.region,
      categorySlug: slugs.slug,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    // Per-city category slug, the same join `submissionDetail` uses: left,
    // because a category not routed in this city has no pillar page to bust.
    .leftJoin(
      slugs,
      and(
        eq(slugs.parentScope, sql`${listings.cityId}::text`),
        eq(slugs.entityId, listings.primaryCategoryId),
        eq(slugs.kind, "category"),
      ),
    )
    .where(eq(listings.id, listingId))
    .limit(1);
  if (!row) return [];

  // What the public route paginates, so PUBLIC_VIEWER whatever the caller is.
  // Counted BEFORE the status change, plus one: a shrink must bust the page
  // that disappears, and a growth across a PER_PAGE boundary must bust the
  // page that appears — a cached 404 for /city/page/N is a 404 for an hour
  // otherwise. Over-inclusive by at most one harmless path.
  const published =
    (await countListings(tx, PUBLIC_VIEWER, { type: "city", cityId: row.cityId })) + 1;

  const listingPath = `/${row.citySlug}/${row.slug}`;
  return [
    listingPath,
    `${listingPath}/reviews`,
    `/${row.citySlug}`,
    ...paginatedCityPaths(row.citySlug, published),
    ...(row.categorySlug === null ? [] : [`/${row.citySlug}/${row.categorySlug}`]),
    // The region pillar and its paginated pages: the listing is on them too,
    // in the same rank order, and the same shrink/grow rule applies.
    ...(await regionPaths(tx, row.region)),
  ];
}
