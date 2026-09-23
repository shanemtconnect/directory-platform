import { eq } from "drizzle-orm";
import { areas, categories, cities, verticals } from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import { isAdmin, PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { countListings } from "@/lib/db/queries/listings";
import type { PillarScope } from "@/lib/routing/scope";
import type { Db } from "@/lib/db/client";

/**
 * The city indexing gate, in one place.
 *
 * Global constraint 9: `is_indexable` requires
 * `listing_count >= siteConfig.seo.minListingsToIndex` AND intro copy. Before
 * this module nothing outside the seed ever wrote either column, so the gate
 * could not open however many listings arrived — and `pillarHeading` handed
 * the vertical scope `isIndexable: true` unconditionally, which is the same
 * bug from the other direction.
 */

export interface Indexability {
  listingCount: number;
  isIndexable: boolean;
}

/**
 * The rule itself. Intro copy that is present but empty is not intro copy —
 * a page whose introduction is `<p></p>` is exactly the thin page the gate
 * exists to keep out of the index.
 */
export function decideIndexability(
  listingCount: number,
  introHtml: string | null,
): Indexability {
  const hasIntro = introHtml !== null && introHtml.trim() !== "";
  const isIndexable =
    listingCount >= siteConfig.seo.minListingsToIndex &&
    (hasIntro || !siteConfig.seo.requireIntroCopyToIndex);
  return { listingCount, isIndexable };
}

/**
 * Recomputes and persists a city's `listing_count` and `is_indexable`.
 *
 * Call this after anything that changes how many published listings a city
 * holds: an import, an approval, a rejection, an unpublish. It closes the gate
 * as readily as it opens it — a city that loses listings must lose indexing
 * too, or the sitemap keeps advertising a page that has gone thin.
 *
 * The count is always the PUBLISHED count. The viewer is threaded for
 * consistency with every other query function but deliberately does not
 * loosen the rule: an admin cannot make a thin city indexable by asking as an
 * admin, because Googlebot is not an admin.
 */
export async function recomputeCityIndexability(
  tx: Db,
  _viewer: Viewer,
  cityId: string,
): Promise<Indexability | null> {
  const [city] = await tx
    .select({ introHtml: cities.introHtml })
    .from(cities)
    .where(eq(cities.id, cityId))
    .limit(1);
  if (!city) return null;

  const listingCount = await countListings(tx, PUBLIC_VIEWER, { type: "city", cityId });
  const out = decideIndexability(listingCount, city.introHtml);

  await tx
    .update(cities)
    .set({ listingCount: out.listingCount, isIndexable: out.isIndexable })
    .where(eq(cities.id, cityId));
  return out;
}

/**
 * What the pillar page needs to decide whether to emit `noindex`, for any of
 * the four scopes the router can produce.
 *
 * Each scope is judged on its OWN published count and its OWN intro copy. A
 * city-category page inheriting the city's flag was how a page with one
 * listing got indexed on the back of a city that had thirty, and the vertical
 * page was handed `true` with no count at all.
 *
 * Returns null when the page should not exist: an unpublished city or area, an
 * inactive vertical or category, or an id that resolves to nothing. Admins
 * still get an answer for unpublished scopes so the admin preview works —
 * the flags it reports are the real ones, not a bypass.
 */
export async function scopeIndexability(
  tx: Db,
  viewer: Viewer,
  scope: PillarScope,
): Promise<Indexability | null> {
  const introHtml = await scopeIntro(tx, viewer, scope);
  if (introHtml === undefined) return null;
  return decideIndexability(await countListings(tx, PUBLIC_VIEWER, scope), introHtml);
}

/**
 * The intro copy the scope's flag is judged on, or `undefined` when the scope
 * is not visible at all. `null` is a real answer meaning "no intro copy yet".
 *
 * A city-category page is judged on the city's introduction because that is
 * the copy the page actually renders — constraint 11 in miniature.
 */
async function scopeIntro(
  tx: Db,
  viewer: Viewer,
  scope: PillarScope,
): Promise<string | null | undefined> {
  const admin = isAdmin(viewer);

  if (scope.type === "city" || scope.type === "city-category") {
    const [city] = await tx
      .select({ introHtml: cities.introHtml, isPublished: cities.isPublished })
      .from(cities).where(eq(cities.id, scope.cityId)).limit(1);
    if (!city) return undefined;
    if (!city.isPublished && !admin) return undefined;

    if (scope.type === "city-category") {
      const [category] = await tx
        .select({ isActive: categories.isActive })
        .from(categories).where(eq(categories.id, scope.categoryId)).limit(1);
      if (!category) return undefined;
      if (!category.isActive && !admin) return undefined;
    }
    return city.introHtml;
  }

  const [vertical] = await tx
    .select({ introHtml: verticals.introHtml, isActive: verticals.isActive })
    .from(verticals).where(eq(verticals.id, scope.verticalId)).limit(1);
  if (!vertical) return undefined;
  if (!vertical.isActive && !admin) return undefined;

  if (scope.type === "vertical-area") {
    const [area] = await tx
      .select({ introHtml: areas.introHtml, isPublished: areas.isPublished })
      .from(areas).where(eq(areas.id, scope.areaId)).limit(1);
    if (!area) return undefined;
    if (!area.isPublished && !admin) return undefined;
    return area.introHtml;
  }
  return vertical.introHtml;
}
