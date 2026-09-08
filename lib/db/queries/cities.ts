import { eq } from "drizzle-orm";
import { cities, categories, verticals, areas } from "@/lib/db/schema";
import type { Viewer } from "@/lib/db/viewer";
import { scopeIndexability } from "@/lib/db/queries/indexing";
import type { PillarScope } from "@/lib/routing/scope";
import type { Db } from "@/lib/db/client";

export interface PillarHeading {
  /** Admin-edited jsonb; validated by the caller before rendering. */
  faq: unknown;
  /** What the H1 says, built from entity nouns — never a hardcoded niche word. */
  title: string;
  place: string;
  introHtml: string | null;
  isIndexable: boolean;
  listingCount: number;
}

/**
 * Resolves a scope to the names the page needs, and to the indexing decision.
 *
 * The flag and the count come from `scopeIndexability`, never from the
 * denormalised `cities.listing_count`/`is_indexable` columns and never from a
 * literal. Those columns are a cache the importer and the approval flow
 * refresh; the page itself must not be able to advertise indexing that the
 * count no longer supports.
 *
 * A null return means the page must 404: an unpublished city or area, an
 * inactive vertical or category, or an id that resolves to nothing.
 */
export async function pillarHeading(
  tx: Db,
  viewer: Viewer,
  scope: PillarScope,
  entityPlural: string,
): Promise<PillarHeading | null> {
  const indexability = await scopeIndexability(tx, viewer, scope);
  if (!indexability) return null;

  if (scope.type === "city" || scope.type === "city-category") {
    const [city] = await tx.select().from(cities).where(eq(cities.id, scope.cityId)).limit(1);
    if (!city) return null;

    let noun = entityPlural;
    if (scope.type === "city-category") {
      const [cat] = await tx.select().from(categories).where(eq(categories.id, scope.categoryId)).limit(1);
      if (!cat) return null;
      noun = cat.name;
    }
    return {
      title: `${noun} in ${city.name}`,
      place: city.name,
      introHtml: city.introHtml,
      ...indexability,
      faq: city.faq,
    };
  }

  const [vertical] = await tx.select().from(verticals).where(eq(verticals.id, scope.verticalId)).limit(1);
  if (!vertical) return null;

  if (scope.type === "vertical-area") {
    const [area] = await tx.select().from(areas).where(eq(areas.id, scope.areaId)).limit(1);
    if (!area) return null;
    return {
      title: `${vertical.name} in ${area.name}`,
      place: area.name,
      introHtml: area.introHtml,
      ...indexability,
      faq: area.faq,
    };
  }
  return {
    title: vertical.name,
    place: vertical.name,
    introHtml: vertical.introHtml,
    ...indexability,
    faq: null,
  };
}
