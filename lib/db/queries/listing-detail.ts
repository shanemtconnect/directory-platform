import { eq, and, ne } from "drizzle-orm";
import { listings, cities, categories, listingImages } from "@/lib/db/schema";
import { listingRankOrder } from "@/lib/db/sort";
import { siteConfig } from "@/config/site.config";
import type { Viewer } from "@/lib/db/viewer";
import {
  publishedListings, publicListingColumns, type PublicListing,
} from "@/lib/db/queries/listings";
import type { Db } from "@/lib/db/client";

export type ListingDetail = {
  listing: PublicListing;
  city: typeof cities.$inferSelect;
  category: typeof categories.$inferSelect | null;
  images: (typeof listingImages.$inferSelect)[];
};

/** Same visibility gate as the pillar query: published only, unless admin. */
export async function getListingDetail(
  tx: Db,
  viewer: Viewer,
  listingId: string,
): Promise<ListingDetail | null> {
  const [row] = await tx
    .select({ listing: publicListingColumns, city: cities, category: categories })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .leftJoin(categories, eq(categories.id, listings.primaryCategoryId))
    .where(and(eq(listings.id, listingId), publishedListings(viewer)))
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
  tx: Db,
  viewer: Viewer,
  listingId: string,
  cityId: string,
  limit = 6,
): Promise<PublicListing[]> {
  return tx
    .select(publicListingColumns)
    .from(listings)
    .where(
      and(
        eq(listings.cityId, cityId),
        ne(listings.id, listingId),
        publishedListings(viewer),
      ),
    )
    .orderBy(...listingRankOrder(siteConfig.timezone))
    .limit(limit);
}
