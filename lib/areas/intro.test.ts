import { describe, it, expect } from "vitest";
import { regionIntro } from "./intro";

const entity = { singular: "venue", plural: "venues" };
const base = { region: "West Yorkshire", country: "United Kingdom", regionLabel: "county", entity };

describe("regionIntro", () => {
  it("states the counts the page shows and nothing else", () => {
    const text = regionIntro({ ...base, listingCount: 12, cityCount: 3 });
    expect(text).toBe(
      "12 venues across 3 locations in West Yorkshire, United Kingdom. " +
      "Each location has its own page; the full list for the county follows.",
    );
  });

  it("agrees in number with one of each", () => {
    const text = regionIntro({ ...base, listingCount: 1, cityCount: 1 });
    expect(text).toContain("1 venue in 1 location in West Yorkshire");
    expect(text).not.toContain("across");
  });

  it("says plainly when there is nothing yet, rather than padding", () => {
    expect(regionIntro({ ...base, listingCount: 0, cityCount: 2 })).toBe(
      "No venues are listed in West Yorkshire yet.",
    );
  });

  it("never contains a niche word of its own — every noun arrives from config", () => {
    const text = regionIntro({
      ...base, listingCount: 4, cityCount: 2,
      entity: { singular: "plumber", plural: "plumbers" },
      regionLabel: "state", country: "United States",
    });
    expect(text).toContain("4 plumbers across 2 locations");
    expect(text).toContain("for the state follows");
  });
});
