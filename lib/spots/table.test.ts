import { describe, expect, it } from "vitest";
import type { BidRow, BiddingListing, SpotRow } from "@/lib/db/queries/spots";
import { citySpotKey, regionSpotKey, spotKeyString } from "@/lib/db/queries/spots";
import { buildSpotTable, monthlyTotalCents, spotKeysFor } from "./table";

const listing: BiddingListing = {
  id: "L1", name: "Mine", cityId: "CITY", cityName: "Leeds", citySlug: "leeds", cityPath: "/leeds",
  region: "West Yorkshire", categoryIds: ["CAT1", "CAT2"], eligible: true, reason: null,
};

const config = { positions: 3, floors: { city: 50, region: 100 } };

function bid(listingId: string, amountCents: number, position: number | null, status: BidRow["status"] = "active"): BidRow {
  return { id: `${listingId}-${amountCents}`, listingId, amountCents, amountSetAt: new Date(), pendingAmountCents: null, createdAt: new Date(), status, position, subscriptionId: null };
}

describe("spotKeysFor", () => {
  it("offers this city and its categories first, then the region, then searched areas", () => {
    const keys = spotKeysFor(listing, [{ id: "OTHER", name: "York", region: "North Yorkshire" }]);
    expect(keys.map((k) => [k.group, k.key.areaKind, k.key.areaId, k.key.categoryId])).toEqual([
      ["here", "city", "CITY", null],
      ["here", "city", "CITY", "CAT1"],
      ["here", "city", "CITY", "CAT2"],
      ["region", "region", "west-yorkshire", null],
      ["region", "region", "west-yorkshire", "CAT1"],
      ["region", "region", "west-yorkshire", "CAT2"],
      ["other", "city", "OTHER", null],
      ["other", "city", "OTHER", "CAT1"],
      ["other", "city", "OTHER", "CAT2"],
      ["other", "region", "north-yorkshire", null],
      ["other", "region", "north-yorkshire", "CAT1"],
      ["other", "region", "north-yorkshire", "CAT2"],
    ]);
  });

  it("does not repeat the listing's own city or region from a search", () => {
    const keys = spotKeysFor({ ...listing, categoryIds: [] }, [{ id: "CITY", name: "Leeds", region: "West Yorkshire" }, { id: "B", name: "Bradford", region: "West Yorkshire" }]);
    expect(keys.map((k) => spotKeyString(k.key))).toEqual(["city:CITY:-", "region:west-yorkshire:-", "city:B:-"]);
  });

  it("has no region rows for a city without one", () => {
    expect(spotKeysFor({ ...listing, region: null, categoryIds: [] })).toHaveLength(1);
  });
});

describe("buildSpotTable", () => {
  const citySpot: SpotRow = { id: "S1", areaKind: "city", areaId: "CITY", categoryId: null, positions: 3, floorCents: 5000, status: "open" };

  it("prices a spot nobody has bid on from the config floors, with no row behind it", () => {
    const rows = buildSpotTable({
      listing, keys: spotKeysFor({ ...listing, categoryIds: [] }), spots: new Map(), bidsBySpot: new Map(),
      areas: [{ key: citySpotKey("CITY", null), areaName: "Leeds", categoryName: null }, { key: regionSpotKey("West Yorkshire", null), areaName: "West Yorkshire", categoryName: null }],
      config,
    });
    expect(rows.map((r) => [r.areaName, r.spotId, r.floorCents, r.minToEnterCents, r.minToTakeFirstCents, r.top])).toEqual([
      ["Leeds", null, 5000, 5000, 5000, []],
      ["West Yorkshire", null, 10_000, 10_000, 10_000, []],
    ]);
  });

  it("shows the public top amounts, the owner's own standing, and the two minimums", () => {
    const bids = [bid("A", 9000, 1), bid("L1", 8000, 2), bid("B", 6000, 3), bid("C", 5500, null, "outbid")];
    const [row] = buildSpotTable({
      listing, keys: [{ key: citySpotKey("CITY", null), group: "here" }],
      spots: new Map([[spotKeyString(citySpot), citySpot]]),
      bidsBySpot: new Map([["S1", bids]]),
      areas: [{ key: citySpotKey("CITY", null), areaName: "Leeds", categoryName: null }],
      config,
    });
    expect(row).toMatchObject({
      spotId: "S1", top: [9000, 8000, 6000], yourAmountCents: 8000, yourPosition: 2, yourStatus: "active",
      // Excluding the owner's own bid: others featured are 9000 and 6000, a
      // position is free, so entering is the floor; leading is 9000 + 10%.
      minToEnterCents: 5000, minToTakeFirstCents: 9900,
    });
  });

  it("totals only the positions the listing holds", () => {
    const rows = buildSpotTable({
      listing, keys: [{ key: citySpotKey("CITY", null), group: "here" }, { key: citySpotKey("CITY", "CAT1"), group: "here" }],
      spots: new Map([[spotKeyString(citySpot), citySpot], ["city:CITY:CAT1", { ...citySpot, id: "S2", categoryId: "CAT1" }]]),
      bidsBySpot: new Map([["S1", [bid("L1", 8000, 1)]], ["S2", [bid("L1", 7000, null, "outbid")]]]),
      areas: [], config,
    });
    expect(monthlyTotalCents(rows)).toBe(8000);
  });
});
