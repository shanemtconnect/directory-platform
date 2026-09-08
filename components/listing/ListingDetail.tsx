import { siteConfig } from "@/config/site.config";
import { countryProfile } from "@/lib/geo/countries";
import type { ListingDetail as Detail } from "@/lib/db/queries/listing-detail";
import type { PublicListing as Listing } from "@/lib/db/queries/listings";
import { EnquiryForm } from "./EnquiryForm";

interface Props {
  detail: Detail;
  related: Listing[];
  cityPath: string;
}

/**
 * Tier gates what is DISPLAYED, never what is reachable. Name, address, phone
 * and the enquiry form are on every tier including unclaimed listings — gating
 * contact details kills the traffic that makes a listing worth paying for.
 */
export function ListingDetail({ detail, related, cityPath }: Props) {
  const { listing, city, category } = detail;
  const tier = siteConfig.tiers[listing.tier];
  const e = siteConfig.entity;
  const profile = countryProfile(city.country);

  const description =
    tier.descriptionDisplay === "full"
      ? (listing.description ?? listing.shortDescription)
      : truncate(listing.description ?? listing.shortDescription, tier.excerptChars);

  return (
    <main>
      <nav aria-label="Breadcrumb">
        <a href="/">Home</a> › <a href={cityPath}>{city.name}</a> › <span>{listing.name}</span>
      </nav>

      <h1>{listing.name}</h1>

      <p data-testid="claim-status">
        {listing.claimStatus === "verified" && (
          <span>Verified{listing.verifiedAt ? ` — checked ${monthYear(listing.verifiedAt)}` : ""}</span>
        )}
        {listing.claimStatus === "claimed" && <span>Claimed by owner</span>}
        {listing.claimStatus === "unclaimed" && <span>Unverified</span>}
      </p>

      {description && <div data-testid="description">{description}</div>}

      {tier.descriptionDisplay === "excerpt" && listing.description &&
        listing.description.length > tier.excerptChars && (
          <p data-testid="description-truncated">
            <a href="/pricing">Upgrade to show the full description.</a>
          </p>
        )}

      <section aria-labelledby="contact">
        <h2 id="contact">Contact</h2>
        <address>
          {listing.addressLine1 && <span>{listing.addressLine1}, </span>}
          <span>{city.name}</span>
          {listing.postcode && <span>, {listing.postcode}</span>}
        </address>
        {listing.phone && <p><a href={`tel:${listing.phone.replace(/\s/g, "")}`}>{listing.phone}</a></p>}
        {tier.showWebsite && listing.website && (
          // rel=nofollow: a directory link is not an editorial endorsement, and
          // selling followed links is a link scheme.
          <p><a href={listing.website} rel="nofollow noopener" target="_blank">Visit website</a></p>
        )}
        {!tier.showWebsite && listing.website && (
          <p data-testid="website-gated">
            Website available on <a href="/pricing">Essential and above</a>.
          </p>
        )}
        <p><a href={`#enquire`}>Send an enquiry</a></p>
      </section>

      {listing.claimStatus === "unclaimed" && (
        <section data-testid="claim-cta">
          <h2>Is this your {e.singular}?</h2>
          <p><a href={`/claim/${listing.slug}`}>Claim it free</a> to edit the details.</p>
          <p><a href="/data-sources">Where this information came from</a> · <a href={`/report/${listing.id}`}>Report incorrect information</a></p>
        </section>
      )}

      {related.length > 0 && (
        <section aria-labelledby="nearby">
          <h2 id="nearby">Other {e.plural} in {city.name}</h2>
          <ul>
            {related.map((r) => (
              <li key={r.id}><a href={`${cityPath}/${r.slug}`}>{r.name}</a></li>
            ))}
          </ul>
        </section>
      )}

      <EnquiryForm listingId={listing.id} listingName={listing.name} />

      <p><small>{category?.name} in {city.name}, {city.region ?? profile.name}</small></p>
    </main>
  );
}

function truncate(text: string | null, chars: number): string | null {
  if (!text || text.length <= chars) return text;
  return `${text.slice(0, chars).replace(/\s+\S*$/, "")}…`;
}

function monthYear(d: Date): string {
  return d.toLocaleDateString(siteConfig.locale, { month: "long", year: "numeric" });
}
