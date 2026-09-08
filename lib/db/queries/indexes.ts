import { sql, eq, and, gt, desc, asc } from "drizzle-orm";
import { cities, categories, listings, verticals } from "@/lib/db/schema";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

export interface CityIndexRow {
  id: string;
  name: string;
  slug: string;
  region: string | null;
  listingCount: number;
  isIndexable: boolean;
}

/**
 * Cities for /cities and for the footer matrix.
 *
 * `onlyIndexable` defaults true and is NOT cosmetic: the footer and sitemap
 * must never link to a page that is noindexed, or we spend crawl budget on
 * pages we have told Google to ignore. Admin views pass false.
 */
export async function listCities(
  tx: TestDb,
  viewer: Viewer,
  opts: { onlyIndexable?: boolean; minListings?: number } = {},
): Promise<CityIndexRow[]> {
  const onlyIndexable = opts.onlyIndexable ?? !isAdmin(viewer);
  const conditions = [eq(cities.isPublished, true)];
  if (onlyIndexable) conditions.push(eq(cities.isIndexable, true));
  if (opts.minListings !== undefined) {
    conditions.push(gt(cities.listingCount, opts.minListings - 1));
  }

  return tx
    .select({
      id: cities.id, name: cities.name, slug: cities.slug,
      region: cities.region, listingCount: cities.listingCount,
      isIndexable: cities.isIndexable,
    })
    .from(cities)
    .where(and(...conditions))
    .orderBy(desc(cities.listingCount), asc(cities.name));
}

export interface CategoryIndexRow {
  id: string;
  name: string;
  slug: string;
  plural: string;
  listingCount: number;
}

/** Categories with a live count, so an empty category is never linked. */
export async function listCategories(
  tx: TestDb,
  viewer: Viewer,
): Promise<CategoryIndexRow[]> {
  const rows = await tx
    .select({
      id: categories.id, name: categories.name, slug: categories.slug,
      plural: categories.plural,
      listingCount: sql<number>`count(${listings.id})::int`,
    })
    .from(categories)
    .leftJoin(
      listings,
      and(
        eq(listings.primaryCategoryId, categories.id),
        isAdmin(viewer) ? sql`true` : eq(listings.status, "published"),
      ),
    )
    .where(eq(categories.isActive, true))
    .groupBy(categories.id, categories.name, categories.slug, categories.plural, categories.sortOrder)
    .orderBy(asc(categories.sortOrder), asc(categories.name));

  return isAdmin(viewer) ? rows : rows.filter((r) => r.listingCount > 0);
}

/** Categories present in one city — the pillar page's internal-linking block. */
export async function categoriesInCity(
  tx: TestDb,
  viewer: Viewer,
  cityId: string,
): Promise<CategoryIndexRow[]> {
  const rows = await tx
    .select({
      id: categories.id, name: categories.name, slug: categories.slug,
      plural: categories.plural,
      listingCount: sql<number>`count(${listings.id})::int`,
    })
    .from(categories)
    .innerJoin(
      listings,
      and(
        eq(listings.primaryCategoryId, categories.id),
        eq(listings.cityId, cityId),
        isAdmin(viewer) ? sql`true` : eq(listings.status, "published"),
      ),
    )
    .groupBy(categories.id, categories.name, categories.slug, categories.plural)
    .orderBy(desc(sql`count(${listings.id})`), asc(categories.name));
  return rows;
}

/**
 * The N nearest cities by great-circle distance — the internal linking engine.
 * Only indexable cities: linking to a noindexed page wastes the crawl.
 */
export async function nearbyCities(
  tx: TestDb,
  cityId: string,
  limit = 6,
): Promise<CityIndexRow[]> {
  const [origin] = await tx
    .select({ lat: cities.lat, lng: cities.lng })
    .from(cities).where(eq(cities.id, cityId)).limit(1);
  if (!origin?.lat || !origin.lng) return [];

  return tx
    .select({
      id: cities.id, name: cities.name, slug: cities.slug,
      region: cities.region, listingCount: cities.listingCount,
      isIndexable: cities.isIndexable,
    })
    .from(cities)
    .where(and(
      eq(cities.isIndexable, true),
      eq(cities.isPublished, true),
      sql`${cities.id} <> ${cityId}`,
      sql`${cities.lat} is not null and ${cities.lng} is not null`,
    ))
    .orderBy(sql`
      6371 * acos(
        least(1, greatest(-1,
          cos(radians(${origin.lat})) * cos(radians(${cities.lat}))
          * cos(radians(${cities.lng}) - radians(${origin.lng}))
          + sin(radians(${origin.lat})) * sin(radians(${cities.lat}))
        ))
      )
    `)
    .limit(limit);
}
