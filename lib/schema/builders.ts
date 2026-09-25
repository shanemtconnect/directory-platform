import type { cities, categories } from "@/lib/db/schema";
import type { PublicListing } from "@/lib/db/queries/listings";
import { siteConfig } from "@/config/site.config";
import { isPlaceholderLegalEntity } from "@/config/validate";
import { countryProfile } from "@/lib/geo/countries";
import { siteOrigin } from "@/lib/site-env";
import type { JsonLd } from "./types";
import { prune } from "./types";

type Listing = PublicListing;
type City = typeof cities.$inferSelect;
type Category = typeof categories.$inferSelect;

const SCHEMA = "https://schema.org";

export function siteUrl(path = ""): string {
  return `${siteOrigin()}${path}`;
}

/** Root layout. Identifies the publisher and wires up the sitelinks searchbox. */
export function organisationSchema(): JsonLd {
  return prune({
    "@context": SCHEMA,
    "@type": siteConfig.schema.organizationType,
    "@id": siteUrl("#organization"),
    name: siteConfig.name,
    url: siteUrl(),
    legalName: isPlaceholderLegalEntity(siteConfig.legalEntity) ? undefined : siteConfig.legalEntity,
    email: siteConfig.supportEmail,
  });
}

export function websiteSchema(): JsonLd {
  return prune({
    "@context": SCHEMA,
    "@type": "WebSite",
    "@id": siteUrl("#website"),
    name: siteConfig.name,
    url: siteUrl(),
    publisher: { "@id": siteUrl("#organization") },
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: siteUrl("/search?q={search_term_string}") },
      "query-input": "required name=search_term_string",
    },
  });
}

export function breadcrumbSchema(trail: { name: string; path: string }[]): JsonLd {
  return prune({
    "@context": SCHEMA,
    "@type": "BreadcrumbList",
    itemListElement: trail.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: siteUrl(crumb.path),
    })),
  });
}

export interface ListingSchemaInput {
  listing: Listing;
  /**
   * Only the three fields this builder reads. Narrow on purpose: the detail
   * query projects a city down to what the page uses (city rows carry the
   * pillar page's `introHtml`), so asking for a whole row here would have
   * forced it back into the RSC payload of every listing page.
   */
  city: Pick<City, "name" | "region" | "country">;
  category: Pick<Category, "schemaTypeOverride"> | null;
  path: string;
  /**
   * The description text the page DISPLAYED — an excerpt on a free tier, the
   * full text on a paid one. Never read off the row here; see below.
   */
  description?: string | null;
  /** Social profile URLs, and only on a tier that renders them. */
  sameAs?: string[];
  imageUrls?: string[];
  /** Only pass these when the rating is genuinely on the page. */
  rating?: { value: number; count: number };
  /**
   * The reviews the page RENDERS, in the order it renders them. Never the
   * whole set — a page showing three must not claim twenty.
   */
  reviews?: RenderedReview[];
  /**
   * The awards the page RENDERS, as the exact text it shows (Task 50;
   * `awardText` in lib/db/queries/awards.ts). schema.org gives LocalBusiness
   * `award` as Text, so it is emitted only from the `awards` table, only on
   * the listing page, and only when at least one is on the page.
   */
  awards?: string[];
}

/**
 * One review, as it appears on the page.
 *
 * Deliberately not the database row: `authorEmail`, the IP and the moderation
 * state have no place in markup, and a builder handed the row would eventually
 * emit one of them.
 */
export interface RenderedReview {
  author: string;
  rating: number;
  title: string | null;
  body: string | null;
  published: Date;
}

/** schema.org wants a date, and the page shows a date, not a timestamp. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The `Review` nodes for a set of reviews that are on the page.
 *
 * `bestRating`/`worstRating` are stated rather than left to default because
 * the default is 5/1 only by convention, and a consumer that assumes a
 * ten-point scale would read every four-star review as poor.
 */
function reviewNodes(written: RenderedReview[]): JsonLd[] {
  return written.map((r) =>
    prune({
      "@type": "Review",
      author: { "@type": "Person", name: r.author },
      reviewRating: {
        "@type": "Rating",
        ratingValue: r.rating,
        bestRating: 5,
        worstRating: 1,
      },
      name: r.title ?? undefined,
      reviewBody: r.body ?? undefined,
      datePublished: isoDate(r.published),
    }),
  );
}

/**
 * A listing's LocalBusiness node.
 *
 * Three rules carry all the risk:
 *  - `aggregateRating` is emitted ONLY when a real rating with a non-zero count
 *    is passed in. Fabricating it is the single most common way directories get
 *    a manual action.
 *  - Markup must match visible content, so every tier-gated field — the
 *    description, the social links — is PASSED IN as rendered rather than read
 *    off the row. A builder that reaches into `listing.description` publishes
 *    2,500 characters for a listing showing 300.
 *  - `email` and `priceRange` are not emitted at all, because the page renders
 *    neither. When either becomes visible it gets a parameter, like the rest.
 */
export function listingSchema(input: ListingSchemaInput): JsonLd {
  const { listing, city, category, path } = input;
  const url = siteUrl(path);
  const profile = countryProfile(city.country);

  return prune({
    "@context": SCHEMA,
    "@type": category?.schemaTypeOverride ?? siteConfig.schema.listingType,
    "@id": `${url}#business`,
    name: listing.name,
    description: input.description ?? undefined,
    url,
    image: input.imageUrls ?? [],
    telephone: listing.phone ?? undefined,
    address: {
      "@type": "PostalAddress",
      streetAddress: listing.addressLine1 ?? undefined,
      addressLocality: city.name,
      addressRegion: city.region ?? undefined,
      postalCode: listing.postcode ?? undefined,
      addressCountry: profile.code,
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: listing.lat ?? undefined,
      longitude: listing.lng ?? undefined,
    },
    sameAs: input.sameAs ?? [],
    aggregateRating:
      input.rating && input.rating.count > 0
        ? {
            "@type": "AggregateRating",
            ratingValue: input.rating.value,
            reviewCount: input.rating.count,
          }
        : undefined,
    // Only what the page shows, and only if it shows any. An empty array is
    // an assertion that there are none, which is not the same as silence.
    review:
      input.reviews && input.reviews.length > 0 ? reviewNodes(input.reviews) : undefined,
    // Same rule as review: only what is on the page, and nothing at all when
    // nothing is.
    award: input.awards && input.awards.length > 0 ? input.awards : undefined,
    isPartOf: { "@id": siteUrl("#website") },
  });
}

/**
 * The standalone /[city]/[listing]/reviews page.
 *
 * A CollectionPage whose mainEntity is the SAME business node the listing page
 * publishes — same `@id` — so the reviews are attached to one entity rather
 * than describing a second business that happens to share a name. It carries
 * no `aggregateRating`: the summary belongs to the business, is rendered on
 * the listing page, and asserting it twice from two URLs is how a rating ends
 * up counted twice.
 *
 * Returns null when there is nothing to show, because a reviews page with no
 * reviews on it is a page that must say nothing at all in its markup.
 */
export function reviewsPageSchema(input: {
  listingName: string;
  listingPath: string;
  path: string;
  reviews: RenderedReview[];
}): JsonLd | null {
  if (input.reviews.length === 0) return null;
  const businessUrl = siteUrl(input.listingPath);
  return prune({
    "@context": SCHEMA,
    "@type": "CollectionPage",
    "@id": `${siteUrl(input.path)}#reviews`,
    url: siteUrl(input.path),
    isPartOf: { "@id": siteUrl("#website") },
    mainEntity: {
      "@id": `${businessUrl}#business`,
      name: input.listingName,
      url: businessUrl,
      review: reviewNodes(input.reviews),
    },
  });
}

/** City / category pillar page: a CollectionPage wrapping an ItemList. */
export function pillarSchema(input: {
  title: string;
  path: string;
  description?: string | null;
  items: { name: string; path: string }[];
}): JsonLd {
  return prune({
    "@context": SCHEMA,
    "@type": "CollectionPage",
    "@id": `${siteUrl(input.path)}#collection`,
    name: input.title,
    description: input.description ?? undefined,
    url: siteUrl(input.path),
    isPartOf: { "@id": siteUrl("#website") },
    // An ItemList asserting "0 items" is noise, and prune keeps it because 0 is
    // a real value. A page with nothing on it gets no collection markup.
    mainEntity:
      input.items.length === 0
        ? undefined
        : {
            "@type": "ItemList",
            numberOfItems: input.items.length,
            itemListElement: input.items.map((item, i) => ({
              "@type": "ListItem",
              position: i + 1,
              name: item.name,
              url: siteUrl(item.path),
            })),
          },
  });
}

export function faqSchema(faq: { question: string; answer: string }[]): JsonLd | null {
  const valid = faq.filter((f) => f.question.trim() !== "" && f.answer.trim() !== "");
  if (valid.length === 0) return null;
  return prune({
    "@context": SCHEMA,
    "@type": "FAQPage",
    mainEntity: valid.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: { "@type": "Answer", text: f.answer },
    })),
  });
}

/**
 * A region page: the same CollectionPage + ItemList as every pillar, plus
 * `about` naming the region as an AdministrativeArea inside its country.
 *
 * The region name and the country are both on the page (the H1 and the
 * intro), so the markup asserts nothing the page does not show. No geo, no
 * population, no boundaries: nothing the page has and nothing it invents.
 */
export function regionPillarSchema(input: {
  title: string;
  region: string;
  path: string;
  description?: string | null;
  items: { name: string; path: string }[];
}): JsonLd {
  const base = pillarSchema(input);
  return prune({
    ...base,
    about: {
      "@type": "AdministrativeArea",
      name: input.region,
      containedInPlace: {
        "@type": "Country",
        name: countryProfile(siteConfig.country).name,
      },
    },
  });
}

/**
 * A neighbourhood page (Task 52): exactly the CollectionPage + ItemList a
 * town × category pillar emits, plus `about` naming the neighbourhood as a
 * Place `containedInPlace` its town. Both names and the town link are on the
 * page (the H1 and the breadcrumb), so nothing here is asserted unseen.
 */
export function neighbourhoodPillarSchema(input: {
  title: string;
  neighbourhood: string;
  city: { name: string; path: string };
  path: string;
  description?: string | null;
  items: { name: string; path: string }[];
}): JsonLd {
  const base = pillarSchema(input);
  return prune({
    ...base,
    about: {
      "@type": "Place",
      name: input.neighbourhood,
      containedInPlace: { "@type": "City", name: input.city.name, url: siteUrl(input.city.path) },
    },
  });
}

