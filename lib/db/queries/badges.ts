import { and, eq, sql, type SQL } from "drizzle-orm";
import { categories, cities, listings } from "@/lib/db/schema";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

/**
 * The one lookup behind the embeddable badge, used by both the SVG route and
 * the "get your badge" page.
 *
 * The badge is served to third-party websites, which makes it the most public
 * thing here: an unpublished, rejected or removed listing must not be able to
 * display one. Same rule as every other public read — published only, unless
 * the viewer is an admin.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BadgeListing {
  id: string;
  name: string;
  slug: string;
  claimStatus: typeof listings.$inferSelect.claimStatus;
  ratingAvg: string | null;
  ratingCount: number;
  citySlug: string;
  cityName: string;
  /** Null when the listing has no primary category. */
  categoryName: string | null;
}

function visibilityFilter(viewer: Viewer): SQL {
  if (isAdmin(viewer)) return sql`true`;
  return eq(listings.status, "published");
}

export async function badgeListing(
  tx: TestDb,
  viewer: Viewer,
  id: string,
): Promise<BadgeListing | null> {
  // The id comes from a URL or a query string, so it is checked before it
  // reaches a uuid column: Postgres answers a malformed one with an exception.
  if (!UUID.test(id)) return null;

  const [row] = await tx
    .select({
      id: listings.id,
      name: listings.name,
      slug: listings.slug,
      claimStatus: listings.claimStatus,
      ratingAvg: listings.ratingAvg,
      ratingCount: listings.ratingCount,
      citySlug: cities.slug,
      cityName: cities.name,
      categoryName: categories.name,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .leftJoin(categories, eq(categories.id, listings.primaryCategoryId))
    .where(and(eq(listings.id, id), visibilityFilter(viewer)))
    .limit(1);

  return row ?? null;
}
