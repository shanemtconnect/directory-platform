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
      <ul data-testid="home-featured" className="card-grid">
        {listings.map((l) => (
          <li
            key={l.id}
            data-tier={l.tier}
            data-claim-status={l.claimStatus}
            className="card card-hover flex flex-col gap-1"
          >
            <a
              href={`/${l.citySlug}/${l.slug}`}
              className="font-heading text-lg leading-snug font-semibold text-ink no-underline hover:text-primary hover:underline"
            >
              {l.name}
            </a>
            <span className="text-sm text-muted">{l.cityName}</span>
            {l.claimStatus === "verified" && (
              <span
                data-testid="verified-badge"
                className="mt-1 inline-flex w-fit items-center rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-on-primary"
              >
                Verified
              </span>
            )}
            {l.shortDescription && <p className="mt-1 mb-0 text-sm text-muted">{l.shortDescription}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
