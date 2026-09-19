import { eq, and, ne } from "drizzle-orm";
import { listings, cities, categories, listingImages } from "@/lib/db/schema";
import { listingRankOrder } from "@/lib/db/sort";
import { siteConfig } from "@/config/site.config";
import type { Viewer } from "@/lib/db/viewer";
import {
  publishedListings, publicListingColumns, type PublicListing,
} from "@/lib/db/queries/listings";
import type { Db } from "@/lib/db/client";

/**
 * The public projection of an image row.
 *
 * `select()` on `listing_images` returns the operational columns too —
 * `derivatives_attempts` and `derivatives_error`, which is a raw worker error
 * string (a sharp decode failure, an R2 status line) written for an operator
 * and not for a visitor. Both reach the browser inside the RSC payload the
 * moment the page renders a gallery. Same rule as `publicListingColumns`:
 * project what the page renders, nothing else.
 */
export const publicImageColumns = {
  id: listingImages.id,
  listingId: listingImages.listingId,
  storagePath: listingImages.storagePath,
  derivatives: listingImages.derivatives,
  alt: listingImages.alt,
  width: listingImages.width,
  height: listingImages.height,
  sortOrder: listingImages.sortOrder,
  isPrimary: listingImages.isPrimary,
} as const;

/** What a reader is allowed to see. Never `listingImages.$inferSelect`. */
export type PublicListingImage = Omit<
  typeof listingImages.$inferSelect,
  "createdAt" | "updatedAt" | "derivativesAttempts" | "derivativesError"
>;

/**
 * The city columns the detail page and its metadata read, and no others.
 *
 * `select({ city: cities })` returned the whole row, and a city row carries
 * `introHtml` — the several-kilobyte block of copy written for the CITY pillar
 * page. It has nothing to do with a listing, and it was shipping inside the RSC
 * payload of every listing page on the site, once per render, to every visitor.
 * `faq`, `metaDescription` and the operational counters rode along with it.
 *
 * Same rule as `publicListingColumns` and `publicImageColumns`: project what
 * the page renders, nothing else. `country` is here for `countryProfile()`,
 * `region` for the address line and the JSON-LD `addressRegion`, `slug` for the
 * canonical path.
 */
export const listingDetailCityColumns = {
  id: cities.id,
  name: cities.name,
  slug: cities.slug,
  region: cities.region,
  country: cities.country,
} as const;

/** The category columns the page and the JSON-LD read. */
export const listingDetailCategoryColumns = {
  id: categories.id,
  name: categories.name,
  slug: categories.slug,
  singular: categories.singular,
  plural: categories.plural,
  schemaTypeOverride: categories.schemaTypeOverride,
} as const;

export type ListingDetailCity = Pick<
  typeof cities.$inferSelect,
  "id" | "name" | "slug" | "region" | "country"
>;

export type ListingDetailCategory = Pick<
  typeof categories.$inferSelect,
  "id" | "name" | "slug" | "singular" | "plural" | "schemaTypeOverride"
>;

export type ListingDetail = {
  listing: PublicListing;
  city: ListingDetailCity;
  category: ListingDetailCategory | null;
  images: PublicListingImage[];
};

/** Same visibility gate as the pillar query: published only, unless admin. */
export async function getListingDetail(
  tx: Db,
  viewer: Viewer,
  listingId: string,
): Promise<ListingDetail | null> {
  const [row] = await tx
    .select({
      listing: publicListingColumns,
      city: listingDetailCityColumns,
      category: listingDetailCategoryColumns,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .leftJoin(categories, eq(categories.id, listings.primaryCategoryId))
    .where(and(eq(listings.id, listingId), publishedListings(viewer)))
    .limit(1);
  if (!row) return null;

  const images = await tx
    .select(publicImageColumns)
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
