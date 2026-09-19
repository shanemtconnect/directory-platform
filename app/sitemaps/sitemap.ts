import type { MetadataRoute } from "next";
import { db } from "@/lib/db/client";
import { prerenderingWithoutDatabase } from "@/lib/db/build-phase";
import { siteUrl } from "@/lib/schema/builders";
import { isStaging } from "@/lib/site-env";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { getAllPosts } from "@/lib/blog/posts";
import {
  sitemapCities,
  sitemapListings,
  sitemapCategories,
  countSitemapListings,
  sitemapShardIds,
  listingShardIndex,
  STATIC_SHARD_ID,
  CATEGORY_SHARD_ID,
  SITEMAP_SHARD_SIZE,
} from "@/lib/db/queries/sitemap";
import { sitemapRoutes } from "@/lib/features/navigation";

// Dynamic, not force-static: the set of indexable cities changes whenever a
// city earns indexing, and a cached-forever sitemap would never show them.
export const dynamic = "force-dynamic";

/**
 * Sharded, because a directory outgrows one file.
 *
 * Each shard is served at /sitemaps/sitemap/<id>.xml and listed by the index at
 * /sitemap.xml. Splitting listings from cities and categories means Search
 * Console reports coverage per URL TYPE, so "the city pages aren't indexed" is
 * something you can see rather than infer.
 *
 * WHY THIS FILE IS NOT app/sitemap.ts: `generateSitemaps` publishes the shards
 * but does NOT generate an index for them, while still reserving /sitemap.xml —
 * so at the root it left the one URL robots.txt advertises returning a 404 and
 * refused to let a route handler serve it. Nesting the shards one segment down
 * frees /sitemap.xml for the index in app/sitemap.xml/route.ts.
 */
export async function generateSitemaps(): Promise<{ id: string }[]> {
  // A staging site advertises nothing at all: no ids means every shard 404s.
  if (isStaging()) return [];
  // Next calls this while collecting page data during `next build`, even though
  // the route is force-dynamic. A build with no database answers with the
  // minimum shard set rather than failing the build: the route renders on
  // demand anyway, and the INDEX at /sitemap.xml is a plain route handler that
  // counts the real listings on every request, so what a crawler is told is
  // computed at runtime and not here. See lib/db/build-phase.ts.
  const total = prerenderingWithoutDatabase()
    ? 0
    : await countSitemapListings(db as never, PUBLIC_VIEWER);
  return sitemapShardIds(total).map((id) => ({ id }));
}

export default async function sitemap({ id }: { id: Promise<string> }): Promise<MetadataRoute.Sitemap> {
  if (isStaging()) return [];
  const shard = await id;

  if (shard === STATIC_SHARD_ID) {
    const [cities, posts] = await Promise.all([
      sitemapCities(db as never, PUBLIC_VIEWER),
      Promise.resolve(getAllPosts()),
    ]);

    return [
      // Static routes come from the SAME source as nav and footer, so a
      // disabled feature cannot leave a URL advertised in the sitemap.
      //
      // No lastModified: these pages change when someone edits the code, and
      // stamping them with "now" on every request told crawlers the whole site
      // changes constantly. A date we cannot compute honestly is better left
      // out than invented.
      ...sitemapRoutes().map((r) => ({
        url: siteUrl(r.href === "/" ? "" : r.href),
        changeFrequency: "weekly" as const,
        priority: r.href === "/" ? 1 : 0.7,
      })),
      ...posts.map((post) => ({
        url: siteUrl(`/blog/${post.slug}`),
        // From the frontmatter: the revision date where there is one, the
        // publication date otherwise. Both are real.
        lastModified: new Date(`${post.updated ?? post.date}T00:00:00Z`),
        changeFrequency: "monthly" as const,
        priority: 0.6,
      })),
      ...cities.map((c) => ({
        url: siteUrl(c.path),
        lastModified: c.lastModified,
        changeFrequency: "daily" as const,
        priority: 0.9,
      })),
    ];
  }

  if (shard === CATEGORY_SHARD_ID) {
    const categories = await sitemapCategories(db as never, PUBLIC_VIEWER);
    return categories.map((c) => ({
      url: siteUrl(c.path),
      lastModified: c.lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }));
  }

  const index = listingShardIndex(shard);
  if (index === null) return [];

  const listings = await sitemapListings(db as never, PUBLIC_VIEWER, {
    offset: index * SITEMAP_SHARD_SIZE,
    limit: SITEMAP_SHARD_SIZE,
  });
  return listings.map((l) => ({
    url: siteUrl(l.path),
    lastModified: l.lastModified,
    changeFrequency: "weekly" as const,
    priority: 0.5,
  }));
}
