import { eq, and, ne, sql } from "drizzle-orm";
import { listings, cities, categories, listingImages } from "@/lib/db/schema";
import { listingRankOrder } from "@/lib/db/sort";
import { siteConfig } from "@/config/site.config";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

export type ListingDetail = {
  listing: typeof listings.$inferSelect;
  city: typeof cities.$inferSelect;
  category: typeof categories.$inferSelect | null;
  images: (typeof listingImages.$inferSelect)[];
};

/** Same visibility gate as the pillar query: published only, unless admin. */
export async function getListingDetail(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<ListingDetail | null> {
  const [row] = await tx
    .select({ listing: listings, city: cities, category: categories })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .leftJoin(categories, eq(categories.id, listings.primaryCategoryId))
    .where(
      isAdmin(viewer)
        ? eq(listings.id, listingId)
        : and(eq(listings.id, listingId), eq(listings.status, "published")),
    )
    .limit(1);
  if (!row) return null;

  const images = await tx
    .select()
    .from(listingImages)
    .where(eq(listingImages.listingId, listingId))
    .orderBy(listingImages.sortOrder);

  return { listing: row.listing, city: row.city, category: row.category, images };
}

/** Other listings in the same city — internal linking, and useful to a visitor. */
export async function relatedListings(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  cityId: string,
  limit = 6,
) {
  return tx
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.cityId, cityId),
        ne(listings.id, listingId),
        isAdmin(viewer) ? sql`true` : eq(listings.status, "published"),
      ),
    )
    .orderBy(...listingRankOrder(siteConfig.timezone))
    .limit(limit);
}
