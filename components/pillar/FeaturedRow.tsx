import type { FeaturedListing } from "@/lib/db/queries/spots";
import { leaderboardPath } from "@/lib/spots/notify";
import { ListingCard } from "./ListingCard";

interface Props {
  /** In position order, exactly as `featuredForScope` returned them. */
  featured: readonly FeaturedListing[];
  /** The page's own noun and place, so the heading matches the h1 below it. */
  nounPlural: string;
  place: string;
}

/**
 * The paid row above the organic grid: the spot's featured bids, in rank
 * order, each card labelled "Featured", and a small "How this works" link to
 * the spot's public leaderboard (Task 45). Nothing else — no placeholder
 * when the spot is empty (the owner-facing upsell is `FeaturedUpsell`,
 * mounted by the page outside this row), and no JSON-LD of its own: these
 * cards are already in the page's ItemList, because they are on the page.
 *
 * Server component inside the ISR tree. The row changes when a bid does,
 * and `spotPaths` in lib/db/queries/spots.ts is what busts this page then.
 * `data-dp-spot` on the list is what the beacon script reads to count a
 * click on one of these cards against this spot.
 */
export function FeaturedRow({ featured, nounPlural, place }: Props) {
  if (featured.length === 0) return null;
  const spotId = featured[0]!.spotId;
  return (
    <section aria-labelledby="featured-row" data-testid="featured-row">
      <h2 id="featured-row">
        Featured {nounPlural} in {place}{" "}
        <a href={leaderboardPath(spotId)} className="text-sm font-normal" data-testid="featured-how">
          How this works
        </a>
      </h2>
      <ul className="card-grid" data-dp-spot={spotId}>
        {/* The listing's OWN city: a listing bidding on another town's page
            still lives at /its-city/slug (I2). */}
        {featured.map((l) => (
          <ListingCard key={l.id} listing={l} basePath={`/${l.citySlug}`} featured position={l.position} />
        ))}
      </ul>
    </section>
  );
}
