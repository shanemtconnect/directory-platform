import { and, eq } from "drizzle-orm";
import { cities, listings } from "@/lib/db/schema";
import { listingRankOrder } from "@/lib/db/sort";
import { siteConfig } from "@/config/site.config";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import {
  listCities,
  listCategories,
  type CityIndexRow,
  type CategoryIndexRow,
} from "@/lib/db/queries/indexes";
import type { Db } from "@/lib/db/client";

/**
 * Homepage blocks. Nothing here is new policy — the homepage is the most
 * linked page on the site, so it must obey exactly the same indexability and
 * visibility rules as every other index, not a relaxed homepage variant.
 */

export const TOP_CITIES = 12;
export const TOP_CATEGORIES = 12;
export const FEATURED_LIMIT = 6;

/**
 * The "browse by location" block.
 *
 * Delegates to `listCities` rather than re-deriving the indexable rule: the
 * homepage linking to a noindexed city would be the single most expensive
 * place in the site to get that wrong. Ordering (count desc, then name) and
 * the admin bypass come with it for free.
 */
export async function topCities(
  tx: Db,
  viewer: Viewer,
  limit = TOP_CITIES,
): Promise<CityIndexRow[]> {
  const rows = await listCities(tx, viewer);
  return rows.slice(0, Math.max(0, limit));
}

/**
 * The "browse by type" block. `listCategories` already drops categories with
 * no published listings, so an empty type is never linked from here.
 */
export async function topCategories(
  tx: Db,
  viewer: Viewer,
  limit = TOP_CATEGORIES,
): Promise<CategoryIndexRow[]> {
  const rows = await listCategories(tx, viewer);
  return rows.slice(0, Math.max(0, limit));
}

export interface FeaturedListingRow {
  id: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  tier: (typeof listings.$inferSelect)["tier"];
  claimStatus: (typeof listings.$inferSelect)["claimStatus"];
  cityName: string;
  citySlug: string;
}

/**
 * The featured row: Premium tier only. This is the thing Premium is sold on,
 * so the tier filter is the product, not a display preference.
 *
 * Deliberately NOT filtered on city indexability. This links a listing page,
 * not a city page, and a paid listing in a thin city has still been paid for.
 * The "never link a non-indexable city" rule governs city links, and the
 * homepage's location block is where that rule bites.
 *
 * Ordered by `listingRankOrder` like every other listing surface — within one
 * tier that leaves rank_boost, claim status and the daily shuffle to decide,
 * so the same six paid listings do not sit on the homepage forever.
 */
export async function featuredListings(
  tx: Db,
  viewer: Viewer,
  limit = FEATURED_LIMIT,
): Promise<FeaturedListingRow[]> {
  if (limit <= 0) return [];

  const conditions = [eq(listings.tier, "premium")];
  if (!isAdmin(viewer)) conditions.push(eq(listings.status, "published"));

  return tx
    .select({
      id: listings.id,
      name: listings.name,
      slug: listings.slug,
      shortDescription: listings.shortDescription,
      tier: listings.tier,
      claimStatus: listings.claimStatus,
      cityName: cities.name,
      citySlug: cities.slug,
    })
    .from(listings)
    .innerJoin(cities, eq(listings.cityId, cities.id))
    .where(and(...conditions))
    .orderBy(...listingRankOrder(siteConfig.timezone))
    .limit(limit);
}
