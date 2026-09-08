import { siteConfig } from "@/config/site.config";
import { countryProfile } from "@/lib/geo/countries";
import type { ListingDetail as Detail } from "@/lib/db/queries/listing-detail";
import type { PublicListing as Listing } from "@/lib/db/queries/listings";
import { displayedDescription } from "@/lib/listing/display";
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

  // Shared with the JSON-LD builder so the markup can never assert a longer
  // description than the one on the page.
  const description = displayedDescription(listing, tier);

  return (
    <main>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
        <a href="/">Home</a> › <a href={cityPath}>{city.name}</a> › <span>{listing.name}</span>
      </nav>

      <h1>{listing.name}</h1>

      <p data-testid="claim-status" className="text-sm text-muted">
        {listing.claimStatus === "verified" && (
          <span>Verified{listing.verifiedAt ? ` — checked ${monthYear(listing.verifiedAt)}` : ""}</span>
        )}
        {listing.claimStatus === "claimed" && <span>Claimed by owner</span>}
        {listing.claimStatus === "unclaimed" && <span>Unverified</span>}
      </p>

      {/* Two columns from lg up: everything about the listing on the left, the
          enquiry form pinned beside it on the right. Below lg they stack in
          source order, which puts the form last — the same order it was in
          before, and the right one on a phone. */}
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          {description && <div data-testid="description" className="prose text-lg">{description}</div>}

          {tier.descriptionDisplay === "excerpt" && listing.description &&
            listing.description.length > tier.excerptChars && (
              <p data-testid="description-truncated">
                <a href="/pricing">Upgrade to show the full description.</a>
              </p>
            )}

          <section aria-labelledby="contact" className="card">
            <h2 id="contact" className="mt-0">Contact</h2>
            <address className="text-muted">
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
            <section data-testid="claim-cta" className="card bg-raised">
              <h2 className="mt-0">Is this your {e.singular}?</h2>
              <p><a href={mailto(`Claim ${listing.name}`)}>Claim it free</a> to edit the details.</p>
            </section>
          )}

          {/* On EVERY listing, not just unclaimed ones. A claimed listing can carry
              a wrong address or belong to a business that has closed, and the
              person who spots it is the visitor, whatever the claim status says.
              Both links are mailto: until /claim and /report ship — an advertised
              route that 404s is worse than an inbox. */}
          <section data-testid="correction-links" className="text-sm text-muted">
            <p>
              <a href="/data-sources">Where this information came from</a>
              {" · "}
              <a href={mailto(`Report ${listing.name}`)}>Report incorrect information</a>
              {" · "}
              <a href={mailto(`Remove ${listing.name}`)}>Request removal</a>
            </p>
          </section>

          {related.length > 0 && (
            <section aria-labelledby="nearby">
              <h2 id="nearby">Other {e.plural} in {city.name}</h2>
              <ul className="link-grid">
                {related.map((r) => (
                  <li key={r.id}><a href={`${cityPath}/${r.slug}`}>{r.name}</a></li>
                ))}
              </ul>
            </section>
          )}

        </div>

        <aside className="lg:sticky lg:top-24">
          <EnquiryForm
            listingId={listing.id}
            listingName={listing.name}
            turnstileSiteKey={process.env.TURNSTILE_SITE_KEY?.trim() || null}
          />
        </aside>
      </div>

      <p className="mt-10"><small>{category?.name} in {city.name}, {city.region ?? profile.name}</small></p>
    </main>
  );
}

/** A support mailto with the subject already filled in. */
function mailto(subject: string): string {
  return `mailto:${siteConfig.supportEmail}?subject=${encodeURIComponent(subject)}`;
}

function monthYear(d: Date): string {
  return d.toLocaleDateString(siteConfig.locale, { month: "long", year: "numeric" });
}
