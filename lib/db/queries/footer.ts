import { sql, eq, and, lte, asc } from "drizzle-orm";
import { cities, categories, listings, slugs } from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import { publishedListings } from "@/lib/db/queries/listings";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

export interface FooterCityLink {
  /** Display name only — the URL is already built. */
  name: string;
  href: string;
  listingCount: number;
}

export interface FooterCategoryBlock {
  id: string;
  name: string;
  plural: string;
  /** The national category page, /categories/[slug]. */
  href: string;
  cities: FooterCityLink[];
}

/**
 * The programmatic footer matrix: every category crossed with the top N cities
 * it actually has listings in.
 *
 * Two invariants, both of them load-bearing, both of them tested:
 *
 * 1. ONLY INDEXABLE CITIES. This is the same gate `sitemapCities` applies
 *    (`is_published AND is_indexable`) and it is enforced here unconditionally,
 *    including for an admin. A link in the footer is a link on every one of
 *    several thousand pages; pointing that at a page we have told Google to
 *    ignore is the single most expensive way to spend crawl budget, and it is
 *    the exact bug the indexing gate exists to prevent. It is not viewer-
 *    dependent because the footer renders inside an ISR-cached shell — an
 *    admin-only variant would be written into the cache everyone else reads.
 *
 * 2. CITY-SCOPED SLUGS. The category segment comes from the slug REGISTRY
 *    scoped to the city, never from `categories.slug`. A category's per-city
 *    route is allocated in that city's namespace and is disambiguated on
 *    collision (a listing in the city may already hold the bare slug), so
 *    building `/{city}/{national slug}` 404s precisely in the collision case.
 *    The inner join also drops any category never routed in that city, rather
 *    than linking a URL that was never allocated. Same pattern as
 *    `categoriesInCity` in ./indexes.ts.
 *
 * ONE round trip for the whole matrix, not one per category: the per-category
 * top-N is a window function over the grouped counts, filtered in a wrapping
 * select. This runs on every page render, so it stays a single statement.
 */
export async function getFooterMatrix(
  tx: TestDb,
  viewer: Viewer,
  opts: { citiesPerCategory?: number } = {},
): Promise<FooterCategoryBlock[]> {
  const perCategory = opts.citiesPerCategory ?? siteConfig.seo.footerCitiesPerCategory;
  if (perCategory < 1) return [];

  const counted = sql<number>`count(${listings.id})`;

  // `parent_scope` is text (it holds the literal 'root' as well as uuids), so
  // the join to cities.id needs an explicit cast.
  const ranked = tx
    // Every column is aliased explicitly. Three of these tables have a `name`
    // and a `slug`, and a subquery projects bare column names, so without the
    // aliases the wrapping select is ambiguous at the SQL level.
    .select({
      categoryId: sql<string>`${categories.id}`.as("category_id"),
      categoryName: sql<string>`${categories.name}`.as("category_name"),
      categoryPlural: sql<string>`${categories.plural}`.as("category_plural"),
      categorySort: sql<number>`${categories.sortOrder}`.as("category_sort"),
      categoryNationalSlug: sql<string>`${categories.slug}`.as("category_national_slug"),
      cityCategorySlug: sql<string>`${slugs.slug}`.as("city_category_slug"),
      cityName: sql<string>`${cities.name}`.as("city_name"),
      citySlug: sql<string>`${cities.slug}`.as("city_slug"),
      listingCount: sql<number>`${counted}::int`.as("listing_count"),
      rank: sql<number>`row_number() over (
        partition by ${categories.id}
        order by ${counted} desc, ${cities.name} asc
      )`.as("rank"),
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .innerJoin(categories, eq(categories.id, listings.primaryCategoryId))
    .innerJoin(
      slugs,
      and(
        sql`${slugs.parentScope} = ${cities.id}::text`,
        eq(slugs.entityId, categories.id),
        eq(slugs.kind, "category"),
      ),
    )
    .where(
      and(
        eq(cities.isPublished, true),
        eq(cities.isIndexable, true),
        eq(categories.isActive, true),
        publishedListings(viewer),
      ),
    )
    // categories.id and cities.id are primary keys, so every other selected
    // column of those tables is functionally dependent on them. slugs.slug is
    // not — the registry's unique key is (parent_scope, slug), so one
    // (city, category) pair could in principle carry more than one row.
    .groupBy(categories.id, cities.id, slugs.slug)
    .as("ranked");

  const rows = await tx
    .select()
    .from(ranked)
    .where(lte(ranked.rank, perCategory))
    .orderBy(asc(ranked.categorySort), asc(ranked.categoryName), asc(ranked.rank));

  const blocks = new Map<string, FooterCategoryBlock>();
  for (const row of rows) {
    let block = blocks.get(row.categoryId);
    if (!block) {
      block = {
        id: row.categoryId,
        name: row.categoryName,
        plural: row.categoryPlural,
        href: `/categories/${row.categoryNationalSlug}`,
        cities: [],
      };
      blocks.set(row.categoryId, block);
    }
    block.cities.push({
      name: row.cityName,
      href: `/${row.citySlug}/${row.cityCategorySlug}`,
      listingCount: row.listingCount,
    });
  }
  return [...blocks.values()];
}
