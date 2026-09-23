import type { EntityNouns } from "@/lib/db/queries/cities";

/**
 * The region page's introduction.
 *
 * A template, not editorial copy: nothing here is a claim about the region
 * beyond the two counts the page renders directly beneath it. A city's intro
 * is written (by the seed, later by an editor) because a city page ranks on
 * its own copy; a region page is a hub over city pages, and inventing "the
 * heart of the region's scene" for every region on every clone is
 * exactly the filler the master plan rules out. Every noun comes from config.
 */
export function regionIntro(input: {
  region: string;
  country: string;
  /** "county", "state", "province" — the country profile's word. */
  regionLabel: string;
  entity: Pick<EntityNouns, "singular" | "plural">;
  listingCount: number;
  cityCount: number;
}): string {
  const { region, country, regionLabel, entity, listingCount, cityCount } = input;
  if (listingCount === 0) return `No ${entity.plural} are listed in ${region} yet.`;

  const things = `${listingCount} ${listingCount === 1 ? entity.singular : entity.plural}`;
  const places = `${cityCount} ${cityCount === 1 ? "location" : "locations"}`;
  const joiner = cityCount === 1 ? "in" : "across";
  return (
    `${things} ${joiner} ${places} in ${region}, ${country}. ` +
    `Each location has its own page; the full list for the ${regionLabel} follows.`
  );
}
