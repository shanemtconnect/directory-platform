import { siteConfig } from "@/config/site.config";
import type { NeighbourhoodLink } from "@/lib/db/queries/neighbourhoods";

interface Props {
  /** From `cityNeighbourhoods`: published, with at least one published listing. */
  neighbourhoods: readonly NeighbourhoodLink[];
  cityPath: string;
  place: string;
}

/**
 * The "Neighbourhoods" block on a town pillar (Task 52): one link per
 * neighbourhood page, the same shape as the by-type links beside it. Hidden
 * entirely when there is nothing to link — an empty heading is noise, and the
 * query has already dropped neighbourhoods with no listings.
 */
export function NeighbourhoodList({ neighbourhoods, cityPath, place }: Props) {
  if (neighbourhoods.length === 0) return null;
  const e = siteConfig.entity;
  return (
    <section aria-labelledby="neighbourhoods" data-testid="neighbourhood-links">
      <h2 id="neighbourhoods">Neighbourhoods in {place}</h2>
      <ul className="link-grid">
        {neighbourhoods.map((n) => (
          <li key={n.id}>
            <a href={`${cityPath}/${n.slug}`}>{e.Plural} in {n.name}</a>{" "}
            <span>({n.listingCount})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
