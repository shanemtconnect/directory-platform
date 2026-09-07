import { describe, it, expect } from "vitest";
import { buildRoutes } from "./navigation";
import { FEATURE_FLAGS, type FeatureMap } from "@/config/types";

const allOff = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as FeatureMap;
const allOn = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, true])) as FeatureMap;

describe("buildRoutes", () => {
  it("always includes core routes regardless of flags", () => {
    const hrefs = buildRoutes(allOff, "niche-national").map((r) => r.href);
    for (const core of [
      "/", "/cities", "/categories", "/search", "/add-listing",
      "/pricing", "/advertise", "/trust", "/data-sources",
    ]) {
      expect(hrefs).toContain(core);
    }
  });

  it("omits every flagged route when all flags are off", () => {
    const hrefs = buildRoutes(allOff, "niche-national").map((r) => r.href);
    for (const flagged of ["/shortlist", "/cost", "/get-quotes", "/guides", "/jobs", "/awards", "/affiliates", "/tools"]) {
      expect(hrefs).not.toContain(flagged);
    }
  });

  it("includes /guides and drops /blog when contentHub is on", () => {
    const hrefs = buildRoutes({ ...allOff, contentHub: true }, "niche-national").map((r) => r.href);
    expect(hrefs).toContain("/guides");
    expect(hrefs).not.toContain("/blog");
  });

  it("includes /blog when contentHub is off", () => {
    expect(buildRoutes(allOff, "niche-national").map((r) => r.href)).toContain("/blog");
  });

  it("never emits /membership — searcher membership is out of scope permanently", () => {
    expect(buildRoutes(allOn, "niche-national").map((r) => r.href)).not.toContain("/membership");
  });

  it("adds /areas only in local-multi-vertical mode", () => {
    expect(buildRoutes(allOff, "niche-national").map((r) => r.href)).not.toContain("/areas");
    expect(buildRoutes(allOff, "local-multi-vertical").map((r) => r.href)).toContain("/areas");
  });

  it("returns no duplicate hrefs under any flag combination", () => {
    for (const f of [allOff, allOn]) {
      for (const mode of ["niche-national", "local-multi-vertical"] as const) {
        const hrefs = buildRoutes(f, mode).map((r) => r.href);
        expect(new Set(hrefs).size).toBe(hrefs.length);
      }
    }
  });

  it("uses entity nouns from config, never a hardcoded niche string", () => {
    const labels = buildRoutes(allOff, "niche-national").map((r) => r.label).join(" ");
    expect(labels).toContain("Venues");
    expect(labels).toContain("venue");
  });

  it("emits every flagged route when all flags are on", () => {
    const hrefs = buildRoutes(allOn, "niche-national").map((r) => r.href);
    for (const flagged of ["/shortlist", "/cost", "/get-quotes", "/guides", "/jobs", "/awards", "/affiliates", "/tools"]) {
      expect(hrefs).toContain(flagged);
    }
  });

  it("marks every route with explicit nav, footer and sitemap membership", () => {
    for (const r of buildRoutes(allOn, "niche-national")) {
      expect(typeof r.inNav).toBe("boolean");
      expect(typeof r.inFooter).toBe("boolean");
      expect(typeof r.inSitemap).toBe("boolean");
    }
  });
});
