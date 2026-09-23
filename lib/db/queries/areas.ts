import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { categories, cities, listings, redirects } from "@/lib/db/schema";
import { listingRankOrder } from "@/lib/db/sort";
import { siteConfig } from "@/config/site.config";
import { isAdmin, PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import {
  PER_PAGE, publishedListings, publicListingColumns, type PublicListing,
} from "@/lib/db/queries/listings";
import { registerRegionSlug, releaseRegionSlug, regionSlug } from "@/lib/routing/slugs";
import { regionPagePath, regionPath } from "@/lib/routing/regions";
import type { Db } from "@/lib/db/client";
import type { TestDb } from "@/lib/db/types";

/**
 * Queries behind the region pages — /areas and /areas/[region].
 *
 * On a niche-national site a region is not a table. It is `cities.region`:
 * the county, state or province the seed and the admin put on each city for
 * disambiguation and schema.org (master plan Part D). The `areas` table in the
 * schema is the local-multi-vertical mode's neighbourhoods and is NOT what
 * these pages read. A region here is therefore a GROUP of cities, computed on
 * read, and every count below is derived from the cities and listings in that
 * group rather than stored anywhere.
 *
 * Every function takes a viewer and applies its own filter; the public sees
 * published cities and published listings only.
 */

export interface RegionRow {
  /** The display name — the `cities.region` value as the seed spelled it. */
  name: string;
  /** slugify(name). Every spelling that slugifies the same is one region. */
  slug: string;
  /**
   * Every `cities.region` spelling grouped under this slug. Normally one; the
   * key every other query in this module takes, so a page resolves the region
   * once and hands the same set to each query.
   */
  names: string[];
  /** Published cities in the region. */
  cityCount: number;
  /** Of which have earned indexing. */
  indexableCityCount: number;
  /** Listings across those cities — published for the public, all for an admin. */
  listingCount: number;
  /**
   * The region page's own gate: at least one city in it has cleared the city
   * gate. A region of thin cities is a thin page with a longer name, so it
   * inherits nothing — it is judged on whether any city under it earned it.
   */
  isIndexable: boolean;
  lastModified: Date;
}

interface RegionAggregate {
  region: string;
  cityCount: number;
  indexableCityCount: number;
  listingCount: number;
  lastModified: Date;
}

/**
 * One row per `cities.region` spelling, over published cities.
 *
 * The listing count is a LEFT join on the published gate so a region whose
 * cities hold nothing published still appears (an admin needs to see it) with
 * a zero rather than vanishing.
 */
async function aggregateRegions(tx: Db, viewer: Viewer): Promise<RegionAggregate[]> {
  return tx
    .select({
      region: sql<string>`${cities.region}`,
      cityCount: sql<number>`count(distinct ${cities.id})::int`,
      indexableCityCount: sql<number>`count(distinct ${cities.id}) filter (where ${cities.isIndexable})::int`,
      listingCount: sql<number>`count(${listings.id})::int`,
      lastModified: sql<Date>`max(${cities.updatedAt})`,
    })
    .from(cities)
    .leftJoin(listings, and(eq(listings.cityId, cities.id), publishedListings(viewer)))
    .where(and(eq(cities.isPublished, true), isNotNull(cities.region)))
    .groupBy(cities.region);
}

/**
 * Regions from the aggregate, grouped by slug.
 *
 * Grouped in code rather than SQL because the slug is `slugify()`, whose
 * exact rules (diacritics, apostrophes) are not worth a second, SQL copy that
 * can drift. Two spellings that slugify the same — "Côte d'Or" and "Cote
 * d'Or" — are one region page, named after the spelling with the most
 * cities; the alternative is two pages competing for one URL.
 */
function groupBySlug(rows: RegionAggregate[]): RegionRow[] {
  const bySlug = new Map<string, RegionRow & { top: number }>();
  for (const row of rows) {
    const slug = regionSlug(row.region);
    if (slug === "") continue;
    const existing = bySlug.get(slug);
    if (!existing) {
      bySlug.set(slug, {
        name: row.region,
        slug,
        names: [row.region],
        cityCount: row.cityCount,
        indexableCityCount: row.indexableCityCount,
        listingCount: row.listingCount,
        isIndexable: row.indexableCityCount > 0,
        lastModified: new Date(row.lastModified),
        top: row.cityCount,
      });
      continue;
    }
    existing.names.push(row.region);
    existing.cityCount += row.cityCount;
    existing.indexableCityCount += row.indexableCityCount;
    existing.listingCount += row.listingCount;
    existing.isIndexable = existing.indexableCityCount > 0;
    const modified = new Date(row.lastModified);
    if (modified > existing.lastModified) existing.lastModified = modified;
    if (row.cityCount > existing.top) {
      existing.top = row.cityCount;
      existing.name = row.region;
    }
  }
  return [...bySlug.values()]
    .map(({ top: _top, ...row }) => row)
    .sort((a, b) => b.listingCount - a.listingCount || a.name.localeCompare(b.name));
}

/**
 * The regions /areas lists, busiest first.
 *
 * For the public, only regions that have earned indexing: /areas is one of
 * the site's internal linkers, and a link to a noindexed page spends crawl
 * budget on a page we have told Google to ignore — the same rule the footer
 * and /cities apply. An admin sees every region so the thin ones are visible.
 */
export async function listRegions(tx: Db, viewer: Viewer): Promise<RegionRow[]> {
  const rows = groupBySlug(await aggregateRegions(tx, viewer));
  return isAdmin(viewer) ? rows : rows.filter((r) => r.isIndexable);
}

export interface RegionCity {
  id: string;
  name: string;
  slug: string;
  listingCount: number;
  /** Whether the city page may be LINKED. A thin city is shown, not linked. */
  isIndexable: boolean;
}

export interface RegionPage extends RegionRow {
  /** Published cities in the region, busiest first. */
  cities: RegionCity[];
}

/**
 * Resolves /areas/<slug> to its region and the cities in it, or null when no
 * published city carries a region that slugifies to it — which is what makes
 * a renamed region's old URL fall through to the redirects table.
 *
 * Exact match only: the route has already lowercased the path and 301'd the
 * other spellings, so a slug arriving here in the wrong case is a bug in the
 * caller, not a lookup to be forgiving about.
 *
 * Unlike `listRegions`, an unindexable region still RESOLVES for the public.
 * Its page renders and works; it is noindex,follow and stays out of the
 * sitemap, exactly as a thin city page does.
 */
export async function regionBySlug(
  tx: Db,
  viewer: Viewer,
  slug: string,
): Promise<RegionPage | null> {
  const region = groupBySlug(await aggregateRegions(tx, viewer)).find((r) => r.slug === slug);
  if (!region) return null;

  const rows = await tx
    .select({
      id: cities.id,
      name: cities.name,
      slug: cities.slug,
      listingCount: sql<number>`count(${listings.id})::int`,
      isIndexable: cities.isIndexable,
    })
    .from(cities)
    .leftJoin(listings, and(eq(listings.cityId, cities.id), publishedListings(viewer)))
    .where(and(eq(cities.isPublished, true), inArray(cities.region, region.names)))
    .groupBy(cities.id, cities.name, cities.slug, cities.isIndexable)
    .orderBy(desc(sql`count(${listings.id})`), asc(cities.name));

  return { ...region, cities: rows };
}

export interface RegionListingRow {
  listing: PublicListing;
  cityName: string;
  citySlug: string;
}

/** Published cities in the named region — the join every listing query shares. */
const regionCities = (names: readonly string[]) =>
  and(eq(cities.isPublished, true), inArray(cities.region, [...names]))!;

/**
 * One page of the region's listings, in the pillar rank order.
 *
 * The city slug comes back with each row because a listing's URL is
 * /[city]/[listing] — constraint 11: the region is never a segment of it.
 */
export async function listRegionListings(
  tx: Db,
  viewer: Viewer,
  names: readonly string[],
  opts: { page?: number; perPage?: number } = {},
): Promise<RegionListingRow[]> {
  if (names.length === 0) return [];
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const perPage = opts.perPage ?? PER_PAGE;

  return tx
    .select({ listing: publicListingColumns, cityName: cities.name, citySlug: cities.slug })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(publishedListings(viewer), regionCities(names)))
    .orderBy(...listingRankOrder(siteConfig.timezone))
    .limit(perPage)
    .offset((page - 1) * perPage);
}

/** Total for the heading, the pagination and the ItemList — one number. */
export async function countRegionListings(
  tx: Db,
  viewer: Viewer,
  names: readonly string[],
): Promise<number> {
  if (names.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(publishedListings(viewer), regionCities(names)));
  return row?.n ?? 0;
}

export interface RegionCategoryRow {
  id: string;
  name: string;
  /** The NATIONAL slug: the link is /categories/<slug>. A per-city route is per city. */
  slug: string;
  plural: string;
  listingCount: number;
}

/**
 * The region's categories, most listed first — the "top categories" block.
 *
 * Links go to the national category page. The per-city category route lives
 * in each city's slug scope and can differ between cities, so there is no
 * single /[city]/[category] a region can point at.
 */
export async function topCategoriesInRegion(
  tx: Db,
  viewer: Viewer,
  names: readonly string[],
  limit = 12,
): Promise<RegionCategoryRow[]> {
  if (names.length === 0) return [];
  return tx
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      plural: categories.plural,
      listingCount: sql<number>`count(${listings.id})::int`,
    })
    .from(categories)
    .innerJoin(
      listings,
      and(eq(listings.primaryCategoryId, categories.id), publishedListings(viewer)),
    )
    .innerJoin(cities, and(eq(cities.id, listings.cityId), regionCities(names)))
    .where(eq(categories.isActive, true))
    .groupBy(categories.id, categories.name, categories.slug, categories.plural)
    .orderBy(desc(sql`count(${listings.id})`), asc(categories.name))
    .limit(limit);
}

/**
 * The sitemap's regions shard. Ignores the viewer for the reason every
 * sitemap query does (lib/db/queries/sitemap.ts): a sitemap has exactly one
 * correct content, the anonymous crawler's.
 */
export async function sitemapRegions(
  tx: Db,
  _viewer: Viewer,
): Promise<{ path: string; lastModified: Date }[]> {
  const rows = await listRegions(tx, PUBLIC_VIEWER);
  return rows
    .map((r) => ({ path: regionPath(r.slug), lastModified: r.lastModified }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Registers a slug for every region any city carries. Idempotent; the seed
 * runs it after the cities are in, and an import can run it after its rows.
 * Returns the slugs it saw, for the caller's report.
 */
export async function registerRegionSlugs(tx: Db): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ region: sql<string>`${cities.region}` })
    .from(cities)
    .where(isNotNull(cities.region));
  const out: string[] = [];
  for (const row of rows) out.push(await registerRegionSlug(tx, row.region));
  return [...new Set(out)];
}

/**
 * Renames a region and preserves its URL — the same contract as
 * `reallocateSlug` for a city (any slug change writes a `redirects` row and
 * serves a 301), spelled out here because a region has no row of its own to
 * reallocate: the name lives on every city in it.
 *
 * A rename that slugifies to the same value rewrites the spelling on the
 * cities and touches nothing else, so an admin correcting whitespace does
 * not write a self-referential redirect.
 */
export async function renameRegion(
  tx: Db,
  viewer: Viewer,
  input: { from: string; to: string },
): Promise<string> {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");

  const oldSlug = regionSlug(input.from);
  await tx.update(cities).set({ region: input.to }).where(eq(cities.region, input.from));

  const newSlug = await registerRegionSlug(tx, input.to);
  if (newSlug === oldSlug) return newSlug;

  await releaseRegionSlug(tx, input.from);

  const oldPath = regionPath(oldSlug);
  const newPath = regionPath(newSlug);
  // Collapse the chain first, as reallocateSlug does: rename twice and the
  // first URL must still be one hop from the current page.
  await tx.update(redirects).set({ toPath: newPath }).where(eq(redirects.toPath, oldPath));
  await tx
    .insert(redirects)
    .values({ fromPath: oldPath, toPath: newPath, statusCode: 301 })
    .onConflictDoUpdate({ target: redirects.fromPath, set: { toPath: newPath } });
  return newSlug;
}

/**
 * The region pages a change to one listing can leave stale: the region
 * pillar and every paginated page of it that exists, counted with the same
 * one-listing allowance `resolveListingPaths` gives the city pages — a
 * growth across a PER_PAGE boundary must bust the page that appears.
 *
 * Public count whatever the caller is: that is what the route paginates.
 */
export async function regionPaths(tx: Db, region: string | null): Promise<string[]> {
  if (region === null) return [];
  const slug = regionSlug(region);
  if (slug === "") return [];
  const published = (await countRegionListings(tx, PUBLIC_VIEWER, [region])) + 1;
  const pages = Math.ceil(published / PER_PAGE);
  const out = [regionPath(slug)];
  for (let n = 2; n <= pages; n++) out.push(regionPagePath(slug, n));
  return out;
}

/**
 * The redirect row for a renamed region's path, if any. Read here rather than
 * in the page so the page holds no Drizzle (constraint 6); a 410 tombstone is
 * returned as-is and the caller decides what a tombstone means.
 */
export async function regionRedirect(
  tx: TestDb,
  _viewer: Viewer,
  fromPath: string,
): Promise<{ to: string; status: number } | null> {
  const [row] = await tx
    .select({ to: redirects.toPath, status: redirects.statusCode })
    .from(redirects)
    .where(eq(redirects.fromPath, fromPath.toLowerCase()))
    .limit(1);
  return row ? { to: row.to, status: row.status } : null;
}
