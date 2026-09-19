import { and, asc, desc, eq, sql } from "drizzle-orm";
import { categories, cities, listings, slugs } from "@/lib/db/schema";
import { listingRankOrder } from "@/lib/db/sort";
import { siteConfig } from "@/config/site.config";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import {
  PER_PAGE, publishedListings, publicListingColumns, type PublicListing,
} from "@/lib/db/queries/listings";
import type { Db } from "@/lib/db/client";

/**
 * Queries behind the NATIONAL category page — /categories/[slug].
 *
 * Categories are global taxonomy: one row, one national page, and a separate
 * slug-registry entry per city that routes /[city]/[category]. This module
 * answers "who is in this category anywhere" and "which cities is it worth
 * linking to", which is a different question from the city-scoped pillar in
 * queries/listings.ts.
 *
 * Every function takes a viewer and applies its own filter. There is no RLS
 * behind this — the data layer is the only gate.
 */

export interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  singular: string;
  plural: string;
  description: string | null;
  isActive: boolean;
}

/**
 * Looks a category up by its national slug. An inactive category is invisible
 * to the public — retiring a category must take its page down, not just its
 * links.
 */
export async function getCategoryBySlug(
  tx: Db,
  viewer: Viewer,
  slug: string,
): Promise<CategoryRow | null> {
  const conditions = [eq(categories.slug, slug.toLowerCase())];
  if (!isAdmin(viewer)) conditions.push(eq(categories.isActive, true));

  const [row] = await tx
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      singular: categories.singular,
      plural: categories.plural,
      description: categories.description,
      isActive: categories.isActive,
    })
    .from(categories)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

export interface NationalListingRow {
  listing: PublicListing;
  cityName: string;
  citySlug: string;
}

/**
 * One page of listings in this category across every city.
 *
 * The city slug comes back with the row because a listing's URL is
 * /[city]/[listing] — a national page cannot build hrefs from a single base
 * path the way a city pillar can.
 */
export async function listCategoryListings(
  tx: Db,
  viewer: Viewer,
  categoryId: string,
  opts: { page?: number; perPage?: number } = {},
): Promise<NationalListingRow[]> {
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const perPage = opts.perPage ?? PER_PAGE;

  return tx
    .select({ listing: publicListingColumns, cityName: cities.name, citySlug: cities.slug })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(publishedListings(viewer), eq(listings.primaryCategoryId, categoryId))!)
    .orderBy(...listingRankOrder(siteConfig.timezone))
    .limit(perPage)
    .offset((page - 1) * perPage);
}

/** Total for pagination, and the zero that drives the noindex decision. */
export async function countCategoryListings(
  tx: Db,
  viewer: Viewer,
  categoryId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(listings)
    .where(and(publishedListings(viewer), eq(listings.primaryCategoryId, categoryId))!);
  return row?.n ?? 0;
}

export interface CategoryCityRow {
  id: string;
  name: string;
  slug: string;
  region: string | null;
  /** Listings in THIS category in that city, not the city's total. */
  listingCount: number;
  isIndexable: boolean;
  /**
   * The category's slug within that city's scope. It is usually the same as
   * the national slug but may have been disambiguated on allocation, so the
   * link is built from this, never from the national slug.
   */
  categorySlug: string;
}

/**
 * The "by location" block: cities where this category has listings.
 *
 * `onlyIndexable` defaults true for the public and is NOT cosmetic. Linking a
 * noindexed city page spends crawl budget on a page we have told Google to
 * ignore, and the national category page is one of the strongest internal
 * linkers on the site. Admin views pass false.
 *
 * The inner join on the slug registry is load-bearing too: a city can hold
 * listings in a category that was never routed there, and linking
 * /[city]/[category] for one of those is a link to a 404.
 */
export async function citiesForCategory(
  tx: Db,
  viewer: Viewer,
  categoryId: string,
  opts: { onlyIndexable?: boolean } = {},
): Promise<CategoryCityRow[]> {
  const onlyIndexable = opts.onlyIndexable ?? !isAdmin(viewer);
  const conditions = [eq(cities.isPublished, true)];
  if (onlyIndexable) conditions.push(eq(cities.isIndexable, true));

  return tx
    .select({
      id: cities.id,
      name: cities.name,
      slug: cities.slug,
      region: cities.region,
      listingCount: sql<number>`count(${listings.id})::int`,
      isIndexable: cities.isIndexable,
      categorySlug: slugs.slug,
    })
    .from(cities)
    .innerJoin(
      listings,
      and(
        eq(listings.cityId, cities.id),
        eq(listings.primaryCategoryId, categoryId),
        publishedListings(viewer),
      ),
    )
    .innerJoin(
      slugs,
      and(
        eq(slugs.parentScope, sql`${cities.id}::text`),
        eq(slugs.entityId, categoryId),
        eq(slugs.kind, "category"),
      ),
    )
    .where(and(...conditions))
    .groupBy(cities.id, cities.name, cities.slug, cities.region, cities.isIndexable, slugs.slug)
    .orderBy(desc(sql`count(${listings.id})`), asc(cities.name));
}
