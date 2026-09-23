import { describe, expect, it } from "vitest";
import { elements, text } from "@/test/elements";
import { siteConfig } from "@/config/site.config";
import type { FeaturedListing } from "@/lib/db/queries/spots";
import type { RegionListingRow, RegionPage } from "@/lib/db/queries/areas";
import type { PublicListing } from "@/lib/db/queries/listings";
import { RegionPillar } from "./RegionPillar";

/**
 * The region page mounts the region spot's featured row (Task 45, the mount
 * Task 44 deferred) above its own list, page 1 only, and does not list a
 * featured listing twice.
 */
function listing(id: string, name: string): PublicListing {
  return {
    id, name, slug: id,
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
const featured = (id: string, name: string, position: number): FeaturedListing =>
  ({ ...listing(id, name), position, citySlug: "leeds", spotId: "spot-r" });
const row = (id: string, name: string): RegionListingRow => ({ listing: listing(id, name), cityName: "Leeds", citySlug: "leeds" });

const region: RegionPage = {
  name: "West Yorkshire", slug: "west-yorkshire", names: ["West Yorkshire"],
  listingCount: 2, cityCount: 1, indexableCityCount: 1, isIndexable: true, lastModified: new Date(),
  cities: [{ id: "c", name: "Leeds", slug: "leeds", listingCount: 2, isIndexable: true }],
};
const props = {
  region, trail: [], title: "T", intro: "I", categories: [], total: 2, totalPages: 1, basePath: "/areas/west-yorkshire",
};

describe("RegionPillar featured row", () => {
  it("renders the featured row on page 1 with the region as the place, and keeps the featured out of the grid", () => {
    const el = RegionPillar({ ...props, page: 1, listings: [row("a", "Alpha"), row("b", "Bravo")], featuredBids: [featured("a", "Alpha", 1)] });
    const all = [...elements(el)];
    const rowEl = all.find((e) => (e.props as Record<string, unknown>)["data-testid"] === "featured-row");
    expect(rowEl).toBeDefined();
    expect(text(el)).toContain(`Featured ${siteConfig.entity.plural} in West Yorkshire`);
    const grid = all.find((e) => (e.props as Record<string, unknown>)["data-testid"] === "listing-grid")!;
    expect(text(grid)).toContain("Bravo");
    expect(text(grid)).not.toContain("Alpha");
  });

  it("no row at all without featured bids, and none on page 2", () => {
    const none = [...elements(RegionPillar({ ...props, page: 1, listings: [row("a", "Alpha")] }))];
    expect(none.some((e) => (e.props as Record<string, unknown>)["data-testid"] === "featured-row")).toBe(false);
    const p2 = [...elements(RegionPillar({ ...props, page: 2, listings: [row("a", "Alpha")], featuredBids: [featured("a", "Alpha", 1)] }))];
    expect(p2.some((e) => (e.props as Record<string, unknown>)["data-testid"] === "featured-row")).toBe(false);
  });
});
