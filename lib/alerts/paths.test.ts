import { describe, expect, it } from "vitest";
import { savedSearchPath } from "./paths";

describe("savedSearchPath", () => {
  it("rebuilds the /search URL from whatever params were saved, fields flattened as the page reads them", () => {
    expect(savedSearchPath("listings", { q: "old barn", city: "leeds", fields: { capacity: "80" } }))
      .toBe("/search?q=old+barn&city=leeds&capacity=80");
    // A filter this file has never heard of still round-trips.
    expect(savedSearchPath("listings", { verified: "1" })).toBe("/search?verified=1");
    expect(savedSearchPath("listings", {})).toBe("/search");
  });

  it("uses the board's own path grammar for a jobs search", () => {
    expect(savedSearchPath("jobs", { citySlug: "leeds", categorySlug: "barn-venues" })).toBe("/jobs/in/leeds/barn-venues");
    expect(savedSearchPath("jobs", {})).toBe("/jobs");
  });
});
