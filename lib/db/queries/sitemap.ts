import { and, eq, asc } from "drizzle-orm";
import { cities, categories, listings } from "@/lib/db/schema";
import type { TestDb } from "@/test/db";

export interface SitemapEntry {
  path: string;
  lastModified: Date;
}

/**
 * The sitemap and the footer link matrix read from HERE, both of them.
 *
 * A noindexed city must never appear in either — advertising a page we have
 * told Google to ignore wastes crawl budget on a site with thousands of pages,
 * and it is the exact bug the indexing gate exists to prevent.
 */
export async function sitemapCities(tx: TestDb): Promise<SitemapEntry[]> {
  const rows = await tx
    .select({ slug: cities.slug, updatedAt: cities.updatedAt })
    .from(cities)
    .where(and(eq(cities.isPublished, true), eq(cities.isIndexable, true)))
    .orderBy(asc(cities.slug));
  return rows.map((r) => ({ path: `/${r.slug}`, lastModified: r.updatedAt }));
}

/** Listings, but only those in a city that has earned indexing. */
export async function sitemapListings(tx: TestDb): Promise<SitemapEntry[]> {
  const rows = await tx
    .select({
      citySlug: cities.slug,
      slug: listings.slug,
      updatedAt: listings.updatedAt,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(
      eq(listings.status, "published"),
      eq(cities.isIndexable, true),
      eq(cities.isPublished, true),
    ))
    .orderBy(asc(cities.slug), asc(listings.slug));
  return rows.map((r) => ({ path: `/${r.citySlug}/${r.slug}`, lastModified: r.updatedAt }));
}

export async function sitemapCategories(tx: TestDb): Promise<SitemapEntry[]> {
  const rows = await tx
    .select({ slug: categories.slug, updatedAt: categories.updatedAt })
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.slug));
  return rows.map((r) => ({ path: `/categories/${r.slug}`, lastModified: r.updatedAt }));
}
