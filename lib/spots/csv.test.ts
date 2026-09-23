import { describe, expect, it } from "vitest";
import { emptySpotsCsv, csvLine } from "./csv";
import type { EmptySpotRow } from "./availability";

const row = (patch: Partial<EmptySpotRow>): EmptySpotRow => ({
  spotId: null, key: { areaKind: "city", areaId: "c1", categoryId: null }, keyString: "city:c1:-",
  areaName: "Leeds", categoryName: null, status: "open", positions: 3, floorCents: 5000, filled: 0, topCents: null, path: "/leeds",
  ...patch,
});

describe("csvLine", () => {
  it("quotes fields with commas, quotes and newlines, and doubles inner quotes", () => {
    expect(csvLine(["a", "b,c", 'say "hi"', "two\nlines", 3])).toBe('a,"b,c","say ""hi""","two\nlines",3');
  });

  it("neutralises a cell that a spreadsheet would run as a formula", () => {
    expect(csvLine(["=SUM(A1)", "+1", "-x", "@cmd", -3])).toBe(`"'=SUM(A1)","'+1","'-x","'@cmd",-3`);
  });
});

describe("emptySpotsCsv", () => {
  it("has the outreach columns, one line per empty open spot, amounts in major units, and a stable header", () => {
    const csv = emptySpotsCsv(
      [
        row({}),
        row({ keyString: "city:c1:k", key: { areaKind: "city", areaId: "c1", categoryId: "k" }, categoryName: "Barns, big", spotId: "s2", filled: 2, topCents: 6000, path: "/leeds/barns" }),
        row({ areaName: "Full", filled: 3, topCents: 9000 }),
        row({ areaName: "Shut", status: "closed" }),
      ],
      "https://example.co.uk",
    );
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("area_kind,area,category,filled,positions,empty,floor,top,page_url,leaderboard_url");
    expect(lines[1]).toBe("city,Leeds,,0,3,3,50,,https://example.co.uk/leeds,");
    expect(lines[2]).toBe('city,Leeds,"Barns, big",2,3,1,50,60,https://example.co.uk/leeds/barns,https://example.co.uk/spots/s2');
    expect(lines).toHaveLength(3);
    expect(csv.endsWith("\r\n")).toBe(false);
  });
});
