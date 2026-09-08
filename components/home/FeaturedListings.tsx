import { siteConfig } from "@/config/site.config";
import type { FeaturedListingRow } from "@/lib/db/queries/homepage";

/**
 * Renders nothing at all when there is no Premium inventory. An empty
 * "Featured" heading on a new site advertises that nobody has paid yet, and
 * leaves a heading in the outline with no content under it.
 */
export function FeaturedListings({ listings }: { listings: FeaturedListingRow[] }) {
  if (listings.length === 0) return null;
  const e = siteConfig.entity;

  return (
    <section aria-labelledby="featured">
      <h2 id="featured">Featured {e.plural}</h2>
      <ul data-testid="home-featured">
        {listings.map((l) => (
          <li key={l.id} data-tier={l.tier} data-claim-status={l.claimStatus}>
            <a href={`/${l.citySlug}/${l.slug}`}>{l.name}</a>
            <span> — {l.cityName}</span>
            {l.claimStatus === "verified" && (
              <span data-testid="verified-badge"> · Verified</span>
            )}
            {l.shortDescription && <p>{l.shortDescription}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
