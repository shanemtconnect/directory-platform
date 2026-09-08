import { and, eq, sql, count, type SQL } from "drizzle-orm";
import { listings } from "@/lib/db/schema";
import { listingRankOrder } from "@/lib/db/sort";
import { siteConfig } from "@/config/site.config";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { PillarScope } from "@/lib/routing/scope";
import type { Db } from "@/lib/db/client";

export const PER_PAGE = 24;

/**
 * The single published-listing gate. Everything public builds on this.
 *
 * There is no RLS behind the data layer, so this function is the only thing
 * standing between the moderation queue and the open web. Admins see
 * everything; every other viewer, signed in or not, sees published only.
 */
function visibilityFilter(viewer: Viewer): SQL {
  if (isAdmin(viewer)) return sql`true`;
  return eq(listings.status, "published");
}

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
  return and(visibilityFilter(viewer), scopeFilter(scope))!;
}

export async function listListings(
  tx: Db,
  viewer: Viewer,
  scope: PillarScope,
  opts: { page?: number; perPage?: number } = {},
) {
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const perPage = opts.perPage ?? PER_PAGE;
  return tx
    .select()
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
