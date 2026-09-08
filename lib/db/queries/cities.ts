import { eq } from "drizzle-orm";
import { cities, categories, verticals, areas } from "@/lib/db/schema";
import type { Viewer } from "@/lib/db/viewer";
import type { PillarScope } from "@/lib/routing/scope";
import type { TestDb } from "@/test/db";

export interface PillarHeading {
  /** What the H1 says, built from entity nouns — never a hardcoded niche word. */
  title: string;
  place: string;
  introHtml: string | null;
  isIndexable: boolean;
  listingCount: number;
}

/**
 * Resolves a scope to the names the page needs. Takes a viewer for consistency
 * with every other query function, even though nothing here is gated: cities
 * and categories are public taxonomy.
 */
export async function pillarHeading(
  tx: TestDb,
  _viewer: Viewer,
  scope: PillarScope,
  entityPlural: string,
): Promise<PillarHeading | null> {
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
      isIndexable: city.isIndexable,
      listingCount: city.listingCount,
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
      isIndexable: area.isIndexable,
      listingCount: area.listingCount,
    };
  }
  return {
    title: vertical.name,
    place: vertical.name,
    introHtml: vertical.introHtml,
    isIndexable: true,
    listingCount: 0,
  };
}
