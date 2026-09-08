import { eq } from "drizzle-orm";
import { cities, categories, verticals, areas } from "@/lib/db/schema";
import type { Viewer } from "@/lib/db/viewer";
import type { PillarScope } from "@/lib/routing/scope";
import type { TestDb } from "@/test/db";

export interface PillarHeading {
  /** Admin-edited jsonb; validated by the caller before rendering. */
  faq: unknown;
  /** What the H1 says, built from entity nouns — never a hardcoded niche word. */
  title: string;
  place: string;
  /**
   * What the things on THIS page are called. On a city pillar that is the
   * site's entity noun; on /city/category it is the category's own noun, so
   * the sub-heading agrees with the H1 instead of widening back out to the
   * whole site.
   */
  nounSingular: string;
  nounPlural: string;
  introHtml: string | null;
  isIndexable: boolean;
  /** The WHOLE scope parent's count. Never the count for this page's scope. */
  listingCount: number;
}

/** Just the nouns, so a clone's entity words arrive from config, not from here. */
export interface EntityNouns {
  readonly singular: string;
  readonly plural: string;
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
  entity: EntityNouns,
): Promise<PillarHeading | null> {
  if (scope.type === "city" || scope.type === "city-category") {
    const [city] = await tx.select().from(cities).where(eq(cities.id, scope.cityId)).limit(1);
    if (!city) return null;

    // The H1 uses the category's display NAME, title-cased; the counted
    // sub-heading uses its sentence-case nouns ("12 {plural} in Leeds").
    let heading = entity.plural;
    let nouns: EntityNouns = entity;
    if (scope.type === "city-category") {
      const [cat] = await tx.select().from(categories).where(eq(categories.id, scope.categoryId)).limit(1);
      if (!cat) return null;
      heading = cat.name;
      nouns = { singular: cat.singular, plural: cat.plural };
    }
    return {
      title: `${heading} in ${city.name}`,
      place: city.name,
      nounSingular: nouns.singular,
      nounPlural: nouns.plural,
      introHtml: city.introHtml,
      isIndexable: city.isIndexable,
      listingCount: city.listingCount,
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
      nounSingular: vertical.singular,
      nounPlural: vertical.plural,
      introHtml: area.introHtml,
      isIndexable: area.isIndexable,
      listingCount: area.listingCount,
      faq: area.faq,
    };
  }
  return {
    title: vertical.name,
    place: vertical.name,
    nounSingular: vertical.singular,
    nounPlural: vertical.plural,
    introHtml: vertical.introHtml,
    isIndexable: true,
    listingCount: 0,
    faq: null,
  };
}
