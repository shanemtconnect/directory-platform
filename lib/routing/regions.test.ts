import { describe, it, expect } from "vitest";
import {
  REGION_BASE, regionPath, regionPagePath, parseRegionSegments,
} from "./regions";
import { MAX_PAGE_NUMBER } from "./resolve";

describe("region paths", () => {
  it("builds /areas/<slug> and its paginated form", () => {
    expect(REGION_BASE).toBe("/areas");
    expect(regionPath("west-yorkshire")).toBe("/areas/west-yorkshire");
    expect(regionPagePath("west-yorkshire", 1)).toBe("/areas/west-yorkshire");
    expect(regionPagePath("west-yorkshire", 2)).toBe("/areas/west-yorkshire/page/2");
  });
});

describe("parseRegionSegments", () => {
  it("parses a region page and its page N", () => {
    expect(parseRegionSegments(["west-yorkshire"])).toEqual({ kind: "page", slug: "west-yorkshire", page: 1 });
    expect(parseRegionSegments(["west-yorkshire", "page", "3"])).toEqual({ kind: "page", slug: "west-yorkshire", page: 3 });
  });

  it("301s mixed case to the lowercase form, and /page/1 to the bare page", () => {
    expect(parseRegionSegments(["West-Yorkshire"])).toEqual({ kind: "redirect", to: "/areas/west-yorkshire" });
    expect(parseRegionSegments(["west-yorkshire", "page", "1"])).toEqual({ kind: "redirect", to: "/areas/west-yorkshire" });
  });

  it("404s anything that is not exactly one region segment", () => {
    expect(parseRegionSegments([])).toEqual({ kind: "not-found" });
    expect(parseRegionSegments(["a", "b"])).toEqual({ kind: "not-found" });
    expect(parseRegionSegments(["page", "2"])).toEqual({ kind: "not-found" });
    expect(parseRegionSegments(["west-yorkshire", "page", "02"])).toEqual({ kind: "not-found" });
    expect(parseRegionSegments(["west-yorkshire", "page", String(MAX_PAGE_NUMBER + 1)])).toEqual({ kind: "not-found" });
  });
});
