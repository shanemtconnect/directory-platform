import type { FeaturedListing } from "@/lib/db/queries/spots";
import { ListingCard } from "./ListingCard";

interface Props {
  /** In position order, exactly as `featuredForScope` returned them. */
  featured: readonly FeaturedListing[];
  /** The page's own noun and place, so the heading matches the h1 below it. */
  nounPlural: string;
  place: string;
  cityPath: string;
}

/**
 * The paid row above the organic grid: the spot's featured bids, in rank
 * order, each card labelled "Featured". Nothing else — no placeholder when
 * the spot is empty (Task 45 adds the owner-facing upsell), and no JSON-LD
 * of its own: these cards are already in the page's ItemList, because they
 * are on the page.
 *
 * Server component inside the ISR tree. The row changes when a bid does,
 * and `spotPaths` in lib/db/queries/spots.ts is what busts this page then.
 */
export function FeaturedRow({ featured, nounPlural, place, cityPath }: Props) {
  if (featured.length === 0) return null;
  return (
    <section aria-labelledby="featured-row" data-testid="featured-row">
      <h2 id="featured-row">Featured {nounPlural} in {place}</h2>
      <ul className="card-grid">
        {featured.map((l) => (
          <ListingCard key={l.id} listing={l} basePath={cityPath} featured position={l.position} />
        ))}
      </ul>
    </section>
  );
}
