import type { PublicListing as Listing } from "@/lib/db/queries/listings";
import { siteConfig } from "@/config/site.config";
import { features } from "@/lib/features/flags";
import { SaveButton } from "@/components/shortlist/SaveButton";
import { StatsBeacon } from "@/components/stats/StatsBeacon";
import { AwardPill } from "@/components/awards/AwardPill";

/**
 * Opening hours are rendered as data attributes and the open/closed state is
 * computed client-side. A server-rendered "Open now" is wrong within the hour
 * and would poison the ISR cache for everyone who sees it afterwards.
 */
export function ListingCard({
  listing, basePath, featured = false, awardYears = [],
}: {
  listing: Listing;
  basePath: string;
  featured?: boolean;
  /** Years this listing won an award (Task 50), from the `awards` table via the route. */
  awardYears?: readonly number[];
}) {
  const tier = siteConfig.tiers[listing.tier];
  const summary =
    tier.descriptionDisplay === "full"
      ? (listing.shortDescription ?? listing.description)
      : listing.shortDescription;

  return (
    <li
      data-tier={listing.tier}
      data-claim-status={listing.claimStatus}
      data-featured={featured}
      className={`card card-hover flex flex-col gap-2 ${featured ? "border-primary" : ""}`}
    >
      {/* The name is the whole click target and the first anchor in the card —
          both the crawl and the e2e suite read it as the listing's link. */}
      <a
        href={`${basePath}/${listing.slug}`}
        className="font-heading text-lg leading-snug font-semibold text-ink no-underline hover:text-primary hover:underline"
      >
        {listing.name}
      </a>

      {/* Not colour alone — the word IS the badge, so it survives a monochrome
          screenshot and a screen reader alike. */}
      {listing.claimStatus === "verified" && (
        <span
          data-testid="verified-badge"
          className="inline-flex w-fit items-center rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-on-primary"
        >
          Verified
        </span>
      )}
      {/* Awards (Task 50): the word is the badge here too. Only from the table. */}
      {features.awards && awardYears.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {awardYears.map((year) => <AwardPill key={year} year={year} />)}
        </span>
      )}
      {listing.claimStatus === "unclaimed" && (
        /* Deliberately quieter than the Verified pill. Most of a young
           directory is unclaimed, and a badge on every card in the grid is
           noise that makes the one badge that means something harder to see. */
        <span className="text-xs text-muted">Unverified</span>
      )}

      {summary && <p className="mb-0 text-sm text-muted">{summary}</p>}
      {features.shortlist && <SaveButton listingId={listing.id} listingName={listing.name} />}

      {listing.openingHours != null && (
        <span
          data-testid="hours"
          data-hours={JSON.stringify(listing.openingHours)}
          data-tz={listing.timezone ?? siteConfig.timezone}
        />
      )}

      {/* One hidden marker per card. Every marker on the page is collected
          into a single POST, so a grid of twenty costs one request. */}
      <StatsBeacon listingId={listing.id} metric="impression" />
    </li>
  );
}
