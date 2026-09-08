import { describe, it, expect, beforeAll } from "vitest";
import {
  organisationSchema, websiteSchema, breadcrumbSchema,
  listingSchema, pillarSchema, faqSchema, siteUrl,
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

  it("omits telephone, email and priceRange entirely when absent", () => {
    const out = listingSchema({ ...base, listing: { ...listing, phone: null } as Listing });
    expect(out).not.toHaveProperty("telephone");
    expect(out).not.toHaveProperty("email");
    expect(out).not.toHaveProperty("priceRange");
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
