import type { cities, categories } from "@/lib/db/schema";
import type { PublicListing } from "@/lib/db/queries/listings";
import { siteConfig } from "@/config/site.config";
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
    legalName: siteConfig.legalEntity === "TBC" ? undefined : siteConfig.legalEntity,
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
  city: City;
  category: Category | null;
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
    isPartOf: { "@id": siteUrl("#website") },
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
