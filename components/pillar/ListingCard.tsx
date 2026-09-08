import type { listings as listingsTable } from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";

type Listing = typeof listingsTable.$inferSelect;

/**
 * Opening hours are rendered as data attributes and the open/closed state is
 * computed client-side. A server-rendered "Open now" is wrong within the hour
 * and would poison the ISR cache for everyone who sees it afterwards.
 */
export function ListingCard({
  listing, basePath, featured = false,
}: { listing: Listing; basePath: string; featured?: boolean }) {
  const tier = siteConfig.tiers[listing.tier];
  const summary =
    tier.descriptionDisplay === "full"
      ? (listing.shortDescription ?? listing.description)
      : listing.shortDescription;

  return (
    <li data-tier={listing.tier} data-claim-status={listing.claimStatus} data-featured={featured}>
      <a href={`${basePath}/${listing.slug}`}>{listing.name}</a>
      {listing.claimStatus === "verified" && <span data-testid="verified-badge"> · Verified</span>}
      {listing.claimStatus === "unclaimed" && <span> · Unverified</span>}
      {summary && <p>{summary}</p>}
      {listing.openingHours != null && (
        <span
          data-testid="hours"
          data-hours={JSON.stringify(listing.openingHours)}
          data-tz={listing.timezone ?? siteConfig.timezone}
        />
      )}
    </li>
  );
}
