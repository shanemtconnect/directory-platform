import { describe, it, expect, beforeAll } from "vitest";
import {
  organisationSchema, websiteSchema, breadcrumbSchema,
  listingSchema, pillarSchema, faqSchema, siteUrl, reviewsPageSchema, regionPillarSchema,
} from "./builders";
import type { listings, cities, categories } from "@/lib/db/schema";

beforeAll(() => { process.env.NEXT_PUBLIC_SITE_URL = "https://example.test"; });

type Listing = typeof listings.$inferSelect;
type City = typeof cities.$inferSelect;
type Category = typeof categories.$inferSelect;

const city = {
  id: "c1", name: "Leeds", slug: "leeds", region: "West Yorkshire", country: "GB",
  lat: 53.8, lng: -1.5,
} as unknown as City;

const listing = {
  id: "l1", name: "The Old Barn", slug: "the-old-barn",
  addressLine1: "1 Farm Lane", postcode: "LS1 1AA",
  phone: "0113 496 0000", email: null, website: null, socials: null,
  description: "A restored barn.", shortDescription: "A restored barn.",
  lat: 53.81, lng: -1.51, priceRange: null,
  ratingAvg: null, ratingCount: 0,
} as unknown as Listing;

const base = { listing, city, category: null as Category | null, path: "/leeds/the-old-barn" };

describe("listingSchema", () => {
  it("NEVER emits aggregateRating when no rating is passed", () => {
    expect(listingSchema(base).aggregateRating).toBeUndefined();
  });

  it("NEVER emits aggregateRating when the count is zero", () => {
    expect(listingSchema({ ...base, rating: { value: 4.8, count: 0 } }).aggregateRating).toBeUndefined();
  });

  it("emits aggregateRating only for a real rating with a real count", () => {
    const out = listingSchema({ ...base, rating: { value: 4.8, count: 12 } });
    expect(out.aggregateRating).toEqual({
      "@type": "AggregateRating", ratingValue: 4.8, reviewCount: 12,
    });
  });

  it("omits telephone when there is none", () => {
    const out = listingSchema({ ...base, listing: { ...listing, phone: null } as Listing });
    expect(out).not.toHaveProperty("telephone");
  });

  it("NEVER emits email or priceRange — the page renders neither", () => {
    // Markup must match visible content. Both fields were being read straight
    // off the row and published on every tier while nothing on the page showed
    // them, which is the exact mismatch constraint 11 exists to prevent.
    const withBoth = {
      ...listing, email: "hi@barn.test", priceRange: "££££",
    } as unknown as Listing;
    const out = listingSchema({ ...base, listing: withBoth });
    expect(out).not.toHaveProperty("email");
    expect(out).not.toHaveProperty("priceRange");
  });

  it("publishes the description the page displayed, not the row's", () => {
    // A free listing renders an excerpt; handing Google the full text would
    // publish copy no visitor can see.
    const out = listingSchema({ ...base, description: "A restored barn…" });
    expect(out.description).toBe("A restored barn…");
  });

  it("omits description entirely when the page rendered none", () => {
    expect(listingSchema(base)).not.toHaveProperty("description");
  });

  it("emits sameAs only from the socials it is handed", () => {
    const withSocials = { ...listing, socials: ["https://x.test/a"] } as unknown as Listing;
    // Tier hides them: the caller passes nothing, so nothing is published.
    expect(listingSchema({ ...base, listing: withSocials })).not.toHaveProperty("sameAs");
    expect(listingSchema({ ...base, listing: withSocials, sameAs: ["https://x.test/a"] }).sameAs)
      .toEqual(["https://x.test/a"]);
  });

  it("omits geo rather than emitting a half-empty node", () => {
    const out = listingSchema({ ...base, listing: { ...listing, lat: null, lng: null } as Listing });
    expect(out).not.toHaveProperty("geo");
  });

  it("omits image and sameAs when there are none", () => {
    const out = listingSchema(base);
    expect(out).not.toHaveProperty("image");
    expect(out).not.toHaveProperty("sameAs");
  });

  it("uses the configured schema type, overridden per category", () => {
    expect(listingSchema(base)["@type"]).toBe("EventVenue");
    const cat = { schemaTypeOverride: "Restaurant" } as Category;
    expect(listingSchema({ ...base, category: cat })["@type"]).toBe("Restaurant");
  });

  it("puts the region in the address, never in the URL", () => {
    const out = listingSchema(base);
    expect((out.address as Record<string, unknown>).addressRegion).toBe("West Yorkshire");
    expect(out.url).toBe("https://example.test/leeds/the-old-barn");
    expect(String(out.url)).not.toContain("west-yorkshire");
  });

  it("uses the country from the city row, so a US site says US", () => {
    const us = { ...city, country: "US", region: "California" } as City;
    const out = listingSchema({ ...base, city: us });
    expect((out.address as Record<string, unknown>).addressCountry).toBe("US");
  });

  it("uses absolute image URLs only", () => {
    const out = listingSchema({ ...base, imageUrls: ["https://cdn.test/a.webp"] });
    expect(out.image).toEqual(["https://cdn.test/a.webp"]);
  });
});

describe("pillarSchema", () => {
  it("emits an ItemList with positions and absolute URLs", () => {
    const out = pillarSchema({
      title: "Venues in Leeds", path: "/leeds",
      items: [{ name: "A", path: "/leeds/a" }, { name: "B", path: "/leeds/b" }],
    });
    const list = out.mainEntity as Record<string, unknown>;
    expect(list.numberOfItems).toBe(2);
    expect((list.itemListElement as Record<string, unknown>[])[0]).toEqual({
      "@type": "ListItem", position: 1, name: "A", url: "https://example.test/leeds/a",
    });
  });

  it("omits mainEntity entirely when the page has no listings", () => {
    expect(pillarSchema({ title: "x", path: "/leeds", items: [] })).not.toHaveProperty("mainEntity");
  });

  it("identifies page N by the page-N URL, never page 1's", () => {
    // /leeds/page/2 asserting /leeds's @id makes two pages claim one identity,
    // and tells Google the second page's listings are on the first.
    const out = pillarSchema({
      title: "Venues in Leeds", path: "/leeds/page/2",
      items: [{ name: "A", path: "/leeds/a" }],
    });
    expect(out.url).toBe("https://example.test/leeds/page/2");
    expect(out["@id"]).toBe("https://example.test/leeds/page/2#collection");
  });
});

describe("breadcrumbSchema", () => {
  it("numbers positions from 1 and uses absolute URLs", () => {
    const out = breadcrumbSchema([{ name: "Home", path: "/" }, { name: "Leeds", path: "/leeds" }]);
    expect(out.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://example.test/" },
      { "@type": "ListItem", position: 2, name: "Leeds", item: "https://example.test/leeds" },
    ]);
  });
});

describe("faqSchema", () => {
  it("returns null with no FAQs, so no empty node is emitted", () => {
    expect(faqSchema([])).toBeNull();
    expect(faqSchema([{ question: "  ", answer: "" }])).toBeNull();
  });

  it("builds a FAQPage from real entries only", () => {
    const out = faqSchema([{ question: "Q?", answer: "A." }, { question: "", answer: "orphan" }]);
    expect((out!.mainEntity as unknown[]).length).toBe(1);
  });
});

describe("organisation and website", () => {
  it("omits legalName while legalEntity is still TBC", () => {
    expect(organisationSchema()).not.toHaveProperty("legalName");
  });

  it("wires SearchAction at the search route", () => {
    const action = websiteSchema().potentialAction as Record<string, unknown>;
    expect((action.target as Record<string, unknown>).urlTemplate)
      .toBe("https://example.test/search?q={search_term_string}");
  });

  it("builds absolute URLs from NEXT_PUBLIC_SITE_URL with no double slash", () => {
    expect(siteUrl("/leeds")).toBe("https://example.test/leeds");
  });
});

/**
 * Review markup is the highest-risk structured data on the site: rich results
 * that assert a rating nobody wrote are exactly what earns a manual action.
 * The rule is the same one aggregateRating already follows — if it is not on
 * the page it is not in the markup.
 */
describe("review markup", () => {
  const written = [
    {
      author: "Sam P",
      rating: 5,
      title: "Did what they said",
      body: "Straightforward from the first reply to the final invoice.",
      published: new Date("2026-03-01T10:00:00Z"),
    },
    {
      author: "Alex T",
      rating: 3,
      title: null,
      body: "Fine, but slow to reply.",
      published: new Date("2026-02-01T10:00:00Z"),
    },
  ];

  it("emits nothing when no reviews are passed", () => {
    expect(listingSchema(base).review).toBeUndefined();
  });

  it("emits nothing for an empty list rather than an empty array", () => {
    expect(listingSchema({ ...base, reviews: [] }).review).toBeUndefined();
  });

  it("emits one Review node per review that is rendered", () => {
    const out = listingSchema({
      ...base, rating: { value: 4, count: 2 }, reviews: written,
    });
    expect(Array.isArray(out.review)).toBe(true);
    expect(out.review).toHaveLength(2);
    expect((out.review as unknown[])[0]).toEqual({
      "@type": "Review",
      author: { "@type": "Person", name: "Sam P" },
      reviewRating: { "@type": "Rating", ratingValue: 5, bestRating: 5, worstRating: 1 },
      name: "Did what they said",
      reviewBody: "Straightforward from the first reply to the final invoice.",
      datePublished: "2026-03-01",
    });
  });

  it("omits a title that was never written rather than inventing one", () => {
    const out = listingSchema({ ...base, reviews: [written[1]!] });
    expect((out.review as Record<string, unknown>[])[0]).not.toHaveProperty("name");
  });

  it("does not emit a rating summary just because reviews were passed", () => {
    expect(listingSchema({ ...base, reviews: written }).aggregateRating).toBeUndefined();
  });

  it("builds a standalone review page as a CollectionPage about the business", () => {
    const out = reviewsPageSchema({
      listingName: "The Old Barn",
      listingPath: "/leeds/the-old-barn",
      path: "/leeds/the-old-barn/reviews",
      reviews: written,
    });
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out["@type"]).toBe("CollectionPage");
    expect(out.url).toBe(siteUrl("/leeds/the-old-barn/reviews"));
    expect(out.mainEntity).toMatchObject({ "@id": `${siteUrl("/leeds/the-old-barn")}#business` });
    expect((out.mainEntity as { review: unknown[] }).review).toHaveLength(2);
  });

  it("returns null for a reviews page with nothing on it", () => {
    expect(reviewsPageSchema({
      listingName: "The Old Barn",
      listingPath: "/leeds/the-old-barn",
      path: "/leeds/the-old-barn/reviews",
      reviews: [],
    })).toBeNull();
  });
});

describe("regionPillarSchema", () => {
  it("is a CollectionPage about the region as an AdministrativeArea in the site's country", () => {
    const out = regionPillarSchema({
      title: "Venues in West Yorkshire", region: "West Yorkshire", path: "/areas/west-yorkshire",
      description: "Two of them.",
      items: [{ name: "The Old Barn", path: "/leeds/the-old-barn" }],
    }) as Record<string, unknown>;
    expect(out["@type"]).toBe("CollectionPage");
    expect(out["url"]).toBe("https://example.test/areas/west-yorkshire");
    expect(out["about"]).toEqual({
      "@type": "AdministrativeArea",
      name: "West Yorkshire",
      containedInPlace: { "@type": "Country", name: "United Kingdom" },
    });
    const list = out["mainEntity"] as { numberOfItems: number; itemListElement: { url: string }[] };
    expect(list.numberOfItems).toBe(1);
    // Constraint 11: the listing's URL is /[city]/[listing], never under the region.
    expect(list.itemListElement[0]!.url).toBe("https://example.test/leeds/the-old-barn");
  });

  it("carries no ItemList for an empty page", () => {
    const out = regionPillarSchema({
      title: "T", region: "R", path: "/areas/r", items: [],
    }) as Record<string, unknown>;
    expect(out["mainEntity"]).toBeUndefined();
  });
});
