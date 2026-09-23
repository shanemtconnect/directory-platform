import { and, eq, asc, desc, gt, isNull, or, sql } from "drizzle-orm";
import { cities, categories, listings } from "@/lib/db/schema";
import { publishedListings } from "@/lib/db/queries/listings";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { features } from "@/lib/features/flags";
import { jobs } from "@/lib/db/schema";
import { now } from "@/lib/clock";

export interface SitemapEntry {
  path: string;
  lastModified: Date;
}

/**
 * URLs per listing shard.
 *
 * Google's ceiling is 50,000 per file; 5,000 keeps each shard small enough to
 * regenerate cheaply and makes a partial failure cost one file rather than the
 * whole index.
 */
export const SITEMAP_SHARD_SIZE = 5000;

/* ------------------------------------------------------------------- shards */

/** Static routes, blog posts and city pillars — everything but the long tails. */
export const STATIC_SHARD_ID = "static+cities";
export const CATEGORY_SHARD_ID = "categories";
/** Region pillars — /areas/<region>. Their own shard so coverage reports per type. */
export const REGION_SHARD_ID = "regions";

const LISTING_SHARD_PREFIX = "listings-";

/** Index of a listing shard, or null for any id that is not one. */
export function listingShardIndex(id: string): number | null {
  if (!id.startsWith(LISTING_SHARD_PREFIX)) return null;
  const rest = id.slice(LISTING_SHARD_PREFIX.length);
  // Strict: "listings-01" and "listings-1.5" are not shard 1 under another
  // name, they are URLs nothing generated, and they must 404 rather than serve
  // a duplicate of a real shard.
  if (!/^(0|[1-9]\d*)$/.test(rest)) return null;
  return Number(rest);
}

export const listingShardId = (index: number): string => `${LISTING_SHARD_PREFIX}${index}`;

/**
 * The shards the index advertises, in order.
 *
 * There is always at least one listing shard, so a brand-new site still serves
 * a well-formed (empty) listings sitemap rather than an index pointing at
 * nothing.
 */
/**
 * Where a shard is served. Next's generateSitemaps convention puts the shards
 * at <route>/sitemap/<id>.xml, and app/sitemaps/sitemap.ts is the route.
 */
export const shardPath = (id: string): string => `/sitemaps/sitemap/${id}.xml`;

export function sitemapShardIds(listingCount: number): string[] {
  const shards = Math.max(1, Math.ceil(listingCount / SITEMAP_SHARD_SIZE));
  return [
    STATIC_SHARD_ID,
    CATEGORY_SHARD_ID,
    REGION_SHARD_ID,
    ...Array.from({ length: shards }, (_, i) => listingShardId(i)),
    // Jobs board (Task 49). A build-time constant, so a flag-off site never
    // advertises a shard whose every URL would 404.
    ...(features.jobBoard ? [JOBS_SHARD_ID] : []),
  ];
}

/** Open jobs, in their own shard so Search Console reports them as a type. */
export const JOBS_SHARD_ID = "jobs";

/**
 * The one published gate, deliberately asked for the ANONYMOUS answer.
 *
 * `publishedListings()` widens to `true` for an admin, and a sitemap is not a
 * viewer-dependent document: an admin-triggered regeneration must not write
 * every draft listing's URL into the file Google fetches. Passing
 * `PUBLIC_VIEWER` rather than the caller's viewer is how "the sitemap has
 * exactly one correct content" is spelled in SQL — and it still routes through
 * the single base query, so there is no second copy of the gate here.
 */
const PUBLISHED = publishedListings(PUBLIC_VIEWER);

/**
 * Every function here takes a viewer for consistency with the rest of the data
 * layer, and every function IGNORES it.
 *
 * A sitemap is a public artefact with exactly one correct content: the URLs an
 * anonymous crawler can fetch. There is no privileged view of it, and honouring
 * an admin viewer would mean an admin-triggered regeneration could publish
 * every draft listing's URL to Google. The parameter documents that the
 * decision was made, rather than that it was forgotten.
 */

/**
 * The sitemap and the footer link matrix read from HERE, both of them.
 *
 * A noindexed city must never appear in either — advertising a page we have
 * told Google to ignore wastes crawl budget on a site with thousands of pages,
 * and it is the exact bug the indexing gate exists to prevent.
 */
export async function sitemapCities(tx: TestDb, _viewer: Viewer): Promise<SitemapEntry[]> {
  const rows = await tx
    .select({ slug: cities.slug, updatedAt: cities.updatedAt })
    .from(cities)
    .where(and(eq(cities.isPublished, true), eq(cities.isIndexable, true)))
    .orderBy(asc(cities.slug));
  return rows.map((r) => ({ path: `/${r.slug}`, lastModified: r.updatedAt }));
}

/**
 * Every published listing, regardless of whether its city has earned indexing.
 *
 * This reverses an earlier, over-broad call. The indexing gate exists to keep
 * THIN CITY PAGES out of the index — a city page with one listing is thin. A
 * listing page is not: it carries a unique name, address, contact details and
 * description. Excluding it also denied a paying owner organic visibility for a
 * reason entirely outside their control, which is the wrong way round.
 *
 * One rule each: cities earn indexing on volume, listings are indexable on
 * their own content.
 *
 * The ordering is total and deterministic (city slug, then listing slug), which
 * is what makes offset paging safe: shard 2 cannot repeat or skip a URL that
 * shard 1 already carried.
 */
export async function sitemapListings(
  tx: TestDb,
  _viewer: Viewer,
  page?: { offset: number; limit: number },
): Promise<SitemapEntry[]> {
  const query = tx
    .select({
      citySlug: cities.slug,
      slug: listings.slug,
      updatedAt: listings.updatedAt,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(PUBLISHED, eq(cities.isPublished, true)))
    .orderBy(asc(cities.slug), asc(listings.slug));

  const rows = page ? await query.limit(page.limit).offset(page.offset) : await query;
  return rows.map((r) => ({ path: `/${r.citySlug}/${r.slug}`, lastModified: r.updatedAt }));
}

/** How many listing URLs there are, and so how many shards the index needs. */
export async function countSitemapListings(tx: TestDb, _viewer: Viewer): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(PUBLISHED, eq(cities.isPublished, true)));
  return row?.n ?? 0;
}

/**
 * ONE rule, in one place: /categories/[slug] sends noindex when this is false,
 * and the sitemap omits the URL when this is false. They were disagreeing —
 * every empty category was listed in the sitemap AND noindexed on its own page.
 */
export const categoryEarnsIndexing = (publishedListings: number): boolean =>
  publishedListings > 0;

/**
 * Active categories that have earned indexing — at least one published listing
 * somewhere. An inactive category is invisible to the public, so retiring one
 * takes its page down and its sitemap entry with it.
 */
export async function sitemapCategories(tx: TestDb, _viewer: Viewer): Promise<SitemapEntry[]> {
  const rows = await tx
    .select({
      slug: categories.slug,
      updatedAt: categories.updatedAt,
      published: sql<number>`count(${listings.id})::int`,
    })
    .from(categories)
    .innerJoin(
      listings,
      and(eq(listings.primaryCategoryId, categories.id), PUBLISHED),
    )
    .where(eq(categories.isActive, true))
    .groupBy(categories.id, categories.slug, categories.updatedAt)
    .orderBy(asc(categories.slug));

  return rows
    .filter((r) => categoryEarnsIndexing(r.published))
    .map((r) => ({ path: `/categories/${r.slug}`, lastModified: r.updatedAt }));
}

/* --------------------------------------------------------- jobs (Task 49) */

/**
 * Every open job, plus the board itself and its per-town and per-category
 * pages. Viewer-blind like the rest of this file, and gated on exactly what
 * the public board shows: published and not past `expires_at`. A closed job
 * still renders (noindexed) but is not advertised.
 */
export async function sitemapJobs(tx: TestDb, _viewer: Viewer): Promise<SitemapEntry[]> {
  const at = now();
  const rows = await tx
    .select({
      id: jobs.id,
      updatedAt: jobs.updatedAt,
      citySlug: cities.slug,
      categorySlug: categories.slug,
    })
    .from(jobs)
    .leftJoin(cities, eq(cities.id, jobs.cityId))
    .leftJoin(categories, eq(categories.id, jobs.categoryId))
    .where(and(eq(jobs.status, "published"), or(isNull(jobs.expiresAt), gt(jobs.expiresAt, at))))
    .orderBy(desc(jobs.publishedAt));

  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();
  const add = (path: string, lastModified: Date) => {
    if (seen.has(path)) return;
    seen.add(path);
    entries.push({ path, lastModified });
  };
  for (const row of rows) {
    add(`/jobs/${row.id}`, row.updatedAt ?? at);
    if (row.citySlug) add(`/jobs/in/${row.citySlug}`, row.updatedAt ?? at);
    if (row.citySlug && row.categorySlug) add(`/jobs/in/${row.citySlug}/${row.categorySlug}`, row.updatedAt ?? at);
    if (row.categorySlug) add(`/jobs/category/${row.categorySlug}`, row.updatedAt ?? at);
  }
  return entries;
}
