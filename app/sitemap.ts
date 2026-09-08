import type { MetadataRoute } from "next";
import { db } from "@/lib/db/client";
import { siteUrl } from "@/lib/schema/builders";
import { isStaging } from "@/lib/site-env";
import { sitemapCities, sitemapListings, sitemapCategories } from "@/lib/db/queries/sitemap";
import { sitemapRoutes } from "@/lib/features/navigation";

// Dynamic, not force-static: the set of indexable cities changes whenever a
// city earns indexing, and a cached-forever sitemap would never show them.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // A staging site advertises nothing.
  if (isStaging()) return [];

  const [cities, listings, categories] = await Promise.all([
    sitemapCities(db as never),
    sitemapListings(db as never),
    sitemapCategories(db as never),
  ]);

  const now = new Date();

  return [
    // Static routes come from the SAME source as nav and footer, so a disabled
    // feature cannot leave a URL advertised in the sitemap.
    ...sitemapRoutes().map((r) => ({
      url: siteUrl(r.href === "/" ? "" : r.href),
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: r.href === "/" ? 1 : 0.7,
    })),
    ...cities.map((c) => ({
      url: siteUrl(c.path),
      lastModified: c.lastModified,
      changeFrequency: "daily" as const,
      priority: 0.9,
    })),
    ...categories.map((c) => ({
      url: siteUrl(c.path),
      lastModified: c.lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
    ...listings.map((l) => ({
      url: siteUrl(l.path),
      lastModified: l.lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.5,
    })),
  ];
}
