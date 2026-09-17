import { eq } from "drizzle-orm";
import { cities, listings } from "@/lib/db/schema";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";

/**
 * The ISR pages a change to one listing can leave stale.
 *
 * Three of them: the listing page itself, its reviews page (same header, same
 * tier gating on the website and socials), and the city pillar, where tier
 * decides the featured row and the sort order. The worker collects these
 * after a tier or backlink_boost write and hands them to
 * `lib/revalidate/client.ts` once the transaction has committed — see the
 * comment there for why "once committed" matters.
 *
 * No published-only filter, on purpose. A listing that has just lapsed or
 * been removed is precisely the one whose cached page is now wrong, and
 * revalidating a path that 404s costs nothing.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listingPaths(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<string[]> {
  // Slugs are public, but this exists for the worker and nothing else should
  // grow a dependency on it.
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
  if (!UUID.test(listingId)) return [];

  const [row] = await tx
    .select({ slug: listings.slug, citySlug: cities.slug })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(listings.id, listingId))
    .limit(1);
  if (!row) return [];

  const listingPath = `/${row.citySlug}/${row.slug}`;
  return [listingPath, `${listingPath}/reviews`, `/${row.citySlug}`];
}
