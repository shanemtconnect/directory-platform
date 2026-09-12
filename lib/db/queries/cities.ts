import { cache } from "react";
import { and, asc, desc, eq } from "drizzle-orm";
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

/**
 * Just the nouns, so a clone's entity words arrive from config, not from here.
 * `Plural` is the title-cased form the H1 uses; `plural` is the sentence-cased
 * one that follows a number.
 */
export interface EntityNouns {
  readonly singular: string;
  readonly plural: string;
  readonly Plural: string;
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
  entity: EntityNouns,
): Promise<PillarHeading | null> {
  const indexability = await scopeIndexability(tx, viewer, scope);
  if (!indexability) return null;

  if (scope.type === "city" || scope.type === "city-category") {
    const [city] = await tx.select().from(cities).where(eq(cities.id, scope.cityId)).limit(1);
    if (!city) return null;

    // The H1 uses the category's display NAME, title-cased; the counted
    // sub-heading uses its sentence-case nouns ("12 {plural} in Leeds").
    let heading = entity.Plural;
    let nouns: { singular: string; plural: string } = entity;
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
      nounSingular: vertical.singular,
      nounPlural: vertical.plural,
      introHtml: area.introHtml,
      ...indexability,
      faq: area.faq,
    };
  }
  return {
    title: vertical.name,
    place: vertical.name,
    nounSingular: vertical.singular,
    nounPlural: vertical.plural,
    introHtml: vertical.introHtml,
    ...indexability,
    faq: null,
  };
}

/** One option in the location switcher. A link, never a form control. */
export interface SwitcherCity {
  id: string;
  name: string;
  slug: string;
  listingCount: number;
  /** The city whose page this is. Rendered as the current value, not a link. */
  isCurrent: boolean;
}

/**
 * How many locations a switcher offers when the caller does not say.
 *
 * A cap rather than "every indexable city" because this runs on cached pages
 * with fifty cities today and no ceiling tomorrow, and a disclosure with two
 * hundred links in it is not a shortcut — /cities is the full list.
 */
export const SWITCHER_LIMIT = 24;

export interface SwitcherOptions {
  /** The city whose page this is. Kept in the list even outside the cap. */
  currentCityId?: string | null;
  /**
   * The same thing as a slug, for a caller that has one and would otherwise
   * have to await another query to turn it into an id — /search reads `?city=`.
   * Resolving it here is what lets that page put this query in its Promise.all
   * instead of running it afterwards. `currentCityId` wins if both are given.
   */
  currentCitySlug?: string | null;
  /** Rows returned, applied in SQL. Defaults to SWITCHER_LIMIT. */
  limit?: number;
}

/**
 * The cities the location switcher may offer.
 *
 * Indexable ones plus, when given, the city the visitor is already on — which
 * may not be indexable, because a page has to be able to say where it is even
 * when it has not earned indexing. Nothing else gets in: the switcher renders
 * a block of real `<a href>`s into pages that are cached and crawled, so
 * listing a noindexed city here would spend crawl budget on a page we have
 * told Google to ignore, exactly as the footer and the sitemap must not.
 *
 * The viewer is threaded for consistency and deliberately changes nothing.
 * `listCities` widens for an admin; this must not. The switcher renders inside
 * the ISR-cached shell, so an extra link rendered for an admin is written into
 * the cache everyone else — crawlers included — then reads back.
 *
 * Busiest first: the switcher is a shortcut to somewhere worth going, and a
 * city with forty listings is a better destination than one with three. Name
 * breaks the tie so the order is stable between renders of the same data.
 *
 * The cap is a LIMIT, not a slice: a caller that wants twelve must not make the
 * database sort and ship every city we hold first. The city you are on is
 * fetched separately when the cap cut it, because a switcher that cannot name
 * where you are is broken — so the list is at most `limit + 1` rows.
 */
const querySwitcherCities = async (
  tx: Db,
  _viewer: Viewer,
  currentCityId: string | null,
  currentCitySlug: string | null,
  limit: number,
): Promise<SwitcherCity[]> => {
  const columns = {
    id: cities.id,
    name: cities.name,
    slug: cities.slug,
    listingCount: cities.listingCount,
  };

  const rows = await tx
    .select(columns)
    .from(cities)
    .where(and(eq(cities.isPublished, true), eq(cities.isIndexable, true)))
    .orderBy(desc(cities.listingCount), asc(cities.name))
    .limit(Math.max(1, limit));

  let currentId =
    currentCityId ?? rows.find((r) => r.slug === currentCitySlug)?.id ?? null;

  if ((currentCityId ?? currentCitySlug) !== null && !rows.some((r) => r.id === currentId)) {
    // Published is still required: an unpublished city has no page to link to,
    // and this is the one row that arrives without the indexable filter.
    const [current] = await tx
      .select(columns)
      .from(cities)
      .where(
        and(
          eq(cities.isPublished, true),
          currentCityId !== null
            ? eq(cities.id, currentCityId)
            : eq(cities.slug, currentCitySlug!),
        ),
      )
      .limit(1);
    if (current) {
      currentId = current.id;
      rows.push(current);
      // Re-sorted rather than appended, so the extra row lands where the single
      // uncapped query would have put it instead of always at the end.
      rows.sort((a, b) => b.listingCount - a.listingCount || a.name.localeCompare(b.name));
    }
  }

  return rows.map((r) => ({ ...r, isCurrent: r.id === currentId }));
};

/**
 * `cache()` on the primitive arguments rather than on the options object,
 * because React keys the cache on argument IDENTITY: a fresh `{ limit: 12 }`
 * literal at each call site would miss every time and the wrapper would buy
 * nothing. Keyed this way, the header and a page that ask for the same list in
 * the same render pay for one query between them.
 *
 * Outside a React render — the unit suite — `cache` calls straight through, so
 * a test that writes rows and asks again still sees them.
 */
const cachedSwitcherCities = cache(querySwitcherCities);

export function listSwitcherCities(
  tx: Db,
  viewer: Viewer,
  options: SwitcherOptions = {},
): Promise<SwitcherCity[]> {
  return cachedSwitcherCities(
    tx,
    viewer,
    options.currentCityId ?? null,
    options.currentCitySlug?.trim() || null,
    options.limit ?? SWITCHER_LIMIT,
  );
}
