import { describe, expect, it } from "vitest";
import { elements, text } from "@/test/elements";
import type { FeaturedListing } from "@/lib/db/queries/spots";
import { FeaturedRow } from "./FeaturedRow";

function listing(id: string, name: string, position: number): FeaturedListing {
  return {
    id, name, slug: id, position,
    createdAt: new Date(), updatedAt: new Date(),
    cityId: "c", areaId: null, verticalId: "v", primaryCategoryId: "cat",
    status: "published", tier: "premium", claimStatus: "verified", ownerId: null,
    addressLine1: null, addressLine2: null, postcode: null, lat: null, lng: null,
    phone: null, email: null, website: null, socials: null,
    shortDescription: null, description: null, offers: null, openingHours: null, timezone: null,
    customFields: null, priceRange: null, rankBoost: 0, backlinkBoost: 0,
    ratingAvg: null, ratingCount: 0, verifiedAt: null, verifiedExpiresAt: null, verifiedBy: null,
    viewCount: 0, enquiryCount: 0, source: "seed", sourceUrl: null, importedAt: null, publishedAt: null,
  };
}

const props = { nounPlural: "venues", place: "Leeds", cityPath: "/leeds" };

describe("FeaturedRow", () => {
  it("renders nothing at all for an empty spot — no placeholder", () => {
    expect(FeaturedRow({ ...props, featured: [] })).toBeNull();
  });

  it("renders the featured listings in the order given, each labelled Featured", () => {
    const el = FeaturedRow({ ...props, featured: [listing("b", "Bravo", 1), listing("a", "Alpha", 2)] })!;
    expect((el.props as Record<string, unknown>)["data-testid"]).toBe("featured-row");
    const cards = [...elements(el)].filter(
      (e) => (e.props as Record<string, unknown>).basePath === "/leeds",
    );
    expect(cards.map((c) => (c.props as { listing: { name: string } }).listing.name)).toEqual(["Bravo", "Alpha"]);
    expect(cards.map((c) => (c.props as { position: number }).position)).toEqual([1, 2]);
    expect(cards.every((c) => (c.props as { featured: boolean }).featured)).toBe(true);
    expect(text(el)).toContain("Featured venues in Leeds");
  });
});
