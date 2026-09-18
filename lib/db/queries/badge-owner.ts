import { and, eq } from "drizzle-orm";
import { badges, categories, cities, listings } from "@/lib/db/schema";
import { ownedByViewer } from "@/lib/db/queries/owner";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";

/**
 * The read behind /advertise/badge/mine: one owned listing, everything the
 * badge gallery needs to render its real snippet, and where the owner said
 * the badge is together with what the last check found.
 *
 * Scoped by the viewer inside the query (constraint 24) with the same
 * predicate the owner portal uses, so a listing id from a query string can be
 * anything at all — a stranger's simply does not match. No published-only
 * gate: this is not a public page, and an owner whose listing is under review
 * still needs to see it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OwnerBadgeStatus {
  id: string;
  name: string;
  /** Site-relative path to the public page. */
  path: string;
  website: string | null;
  cityName: string;
  /** Null when the listing has no primary category. */
  categoryName: string | null;
  claimStatus: typeof listings.$inferSelect.claimStatus;
  ratingAvg: string | null;
  ratingCount: number;
  /** Null until the owner has told us where the badge is. */
  backlinkUrl: string | null;
  backlinkVerified: boolean;
  /** Null until the worker has looked, and again after a re-registration. */
  lastCheckedAt: Date | null;
}

export async function ownerBadgeStatus(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<OwnerBadgeStatus | null> {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
  if (!UUID.test(listingId)) return null;

  const [row] = await tx
    .select({
      id: listings.id,
      name: listings.name,
      slug: listings.slug,
      citySlug: cities.slug,
      website: listings.website,
      cityName: cities.name,
      categoryName: categories.name,
      claimStatus: listings.claimStatus,
      ratingAvg: listings.ratingAvg,
      ratingCount: listings.ratingCount,
      backlinkUrl: badges.backlinkUrl,
      backlinkVerified: badges.backlinkVerified,
      lastCheckedAt: badges.lastCheckedAt,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .leftJoin(categories, eq(categories.id, listings.primaryCategoryId))
    .leftJoin(badges, eq(badges.listingId, listings.id))
    .where(and(eq(listings.id, listingId), ownedByViewer(viewer)))
    .limit(1);
  if (!row) return null;

  const { slug, citySlug, backlinkUrl, backlinkVerified, lastCheckedAt, ...rest } = row;
  return {
    ...rest,
    path: `/${citySlug}/${slug}`,
    backlinkUrl: backlinkUrl ?? null,
    // A left join: no badge row yet reads as "nothing registered".
    backlinkVerified: backlinkVerified ?? false,
    lastCheckedAt: lastCheckedAt ?? null,
  };
}
