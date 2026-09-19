import { and, eq, sql, count, type SQL } from "drizzle-orm";
import { listings } from "@/lib/db/schema";
import { listingRankOrder } from "@/lib/db/sort";
import { siteConfig } from "@/config/site.config";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { PillarScope } from "@/lib/routing/scope";
import type { Db } from "@/lib/db/client";

export const PER_PAGE = 24;

/**
 * THE published-listing gate. Every public read of `listings` — here, on the
 * national category page, in search, on the listing detail page, in the
 * sitemap and in the index queries — builds its WHERE clause on this one call.
 *
 * There is no RLS behind the data layer, so this function is the only thing
 * standing between the moderation queue and the open web. Admins see
 * everything; every other viewer, signed in or not, sees published only. If
 * the string 'published' appears next to `listings.status` anywhere else in
 * the codebase, that is the bug this exists to prevent.
 */
export function publishedListings(viewer: Viewer): SQL {
  if (isAdmin(viewer)) return sql`true`;
  return eq(listings.status, "published");
}

/**
 * THE public projection. `select()` with no argument returns the whole row,
 * and the whole row carries the submitter's email address, the submission blob
 * (their email again, plus their IP), the evidence gathered during
 * verification and the moderator's private rejection note. All four reach the
 * browser inside the RSC payload the moment a page renders a listing.
 *
 * `custom_fields - 'submission'` strips the submission blob while keeping the
 * niche fields the page actually renders. A null jsonb stays null.
 */
export const publicListingColumns = {
  id: listings.id,
  createdAt: listings.createdAt,
  updatedAt: listings.updatedAt,
  name: listings.name,
  slug: listings.slug,
  cityId: listings.cityId,
  areaId: listings.areaId,
  verticalId: listings.verticalId,
  primaryCategoryId: listings.primaryCategoryId,
  status: listings.status,
  tier: listings.tier,
  claimStatus: listings.claimStatus,
  ownerId: listings.ownerId,
  addressLine1: listings.addressLine1,
  addressLine2: listings.addressLine2,
  postcode: listings.postcode,
  lat: listings.lat,
  lng: listings.lng,
  phone: listings.phone,
  email: listings.email,
  website: listings.website,
  socials: listings.socials,
  shortDescription: listings.shortDescription,
  description: listings.description,
  offers: listings.offers,
  openingHours: listings.openingHours,
  timezone: listings.timezone,
  customFields: sql<unknown>`${listings.customFields} - 'submission'`.as("custom_fields"),
  priceRange: listings.priceRange,
  rankBoost: listings.rankBoost,
  backlinkBoost: listings.backlinkBoost,
  ratingAvg: listings.ratingAvg,
  ratingCount: listings.ratingCount,
  verifiedAt: listings.verifiedAt,
  verifiedExpiresAt: listings.verifiedExpiresAt,
  verifiedBy: listings.verifiedBy,
  viewCount: listings.viewCount,
  enquiryCount: listings.enquiryCount,
  source: listings.source,
  sourceUrl: listings.sourceUrl,
  importedAt: listings.importedAt,
  publishedAt: listings.publishedAt,
} as const;

/** What a non-admin reader is allowed to see. Never `listings.$inferSelect`. */
export type PublicListing = Omit<
  typeof listings.$inferSelect,
  "submittedByEmail" | "verificationChecks" | "rejectedReason"
>;

function scopeFilter(scope: PillarScope): SQL {
  switch (scope.type) {
    case "city":
      return eq(listings.cityId, scope.cityId);
    case "city-category":
      return and(
        eq(listings.cityId, scope.cityId),
        eq(listings.primaryCategoryId, scope.categoryId),
      )!;
    case "vertical":
      return eq(listings.verticalId, scope.verticalId);
    case "vertical-area":
      return and(
        eq(listings.verticalId, scope.verticalId),
        eq(listings.areaId, scope.areaId),
      )!;
  }
}

function where(viewer: Viewer, scope: PillarScope): SQL {
  return and(publishedListings(viewer), scopeFilter(scope))!;
}

export async function listListings(
  tx: Db,
  viewer: Viewer,
  scope: PillarScope,
  opts: { page?: number; perPage?: number } = {},
): Promise<PublicListing[]> {
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const perPage = opts.perPage ?? PER_PAGE;
  return tx
    .select(publicListingColumns)
    .from(listings)
    .where(where(viewer, scope))
    .orderBy(...listingRankOrder(siteConfig.timezone))
    .limit(perPage)
    .offset((page - 1) * perPage);
}

export async function countListings(
  tx: Db,
  viewer: Viewer,
  scope: PillarScope,
): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(listings).where(where(viewer, scope));
  return row?.n ?? 0;
}
