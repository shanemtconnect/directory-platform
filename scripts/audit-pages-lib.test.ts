import { describe, expect, it } from "vitest";
import {
  busiestCity,
  cityCategoryPathFromHtml,
  classifySitemapPaths,
  failingViolations,
  filterPages,
  formatTable,
  listingIdFromHtml,
  pageMisses,
  selectPages,
  summarise,
  thresholdsFromEnv,
  type PageResult,
} from "./audit-pages-lib.mjs";

const THRESHOLDS = thresholdsFromEnv({});

function result(overrides: Partial<PageResult> = {}): PageResult {
  return {
    name: "home",
    path: "/",
    finalUrl: "http://localhost:3241/",
    status: 200,
    lighthouse: {
      mobile: { performance: 90, accessibility: 100, "best-practices": 100, seo: 100 },
      desktop: { performance: 99, accessibility: 100, "best-practices": 100, seo: 100 },
    },
    axe: [],
    notes: [],
    errors: [],
    ...overrides,
  };
}

describe("thresholdsFromEnv", () => {
  it("defaults to the brief's numbers", () => {
    expect(THRESHOLDS).toEqual({ performance: 80, accessibility: 95, "best-practices": 90, seo: 95 });
  });

  it("reads overrides and ignores blanks", () => {
    expect(thresholdsFromEnv({ AUDIT_MIN_PERFORMANCE: "70", AUDIT_MIN_SEO: "  " }).performance).toBe(70);
    expect(thresholdsFromEnv({ AUDIT_MIN_SEO: "" }).seo).toBe(95);
  });

  it("rejects a value that is not a score", () => {
    expect(() => thresholdsFromEnv({ AUDIT_MIN_ACCESSIBILITY: "high" })).toThrow(/AUDIT_MIN_ACCESSIBILITY/);
    expect(() => thresholdsFromEnv({ AUDIT_MIN_ACCESSIBILITY: "101" })).toThrow(/AUDIT_MIN_ACCESSIBILITY/);
  });
});

describe("pageMisses", () => {
  it("passes a page at or above every threshold with no axe failures", () => {
    expect(pageMisses(result(), THRESHOLDS)).toEqual([]);
  });

  it("names the form factor, category and score of every miss", () => {
    const r = result({
      lighthouse: {
        mobile: { performance: 79, accessibility: 95, "best-practices": 90, seo: 95 },
        desktop: { performance: 99, accessibility: 94, "best-practices": 100, seo: 100 },
      },
    });
    expect(pageMisses(r, THRESHOLDS)).toEqual(["mobile performance: 79 < 80", "desktop accessibility: 94 < 95"]);
  });

  it("treats a missing score as a miss and a missing form factor as not run", () => {
    const r = result({
      lighthouse: { mobile: { performance: null, accessibility: 100, "best-practices": 100, seo: 100 } },
    });
    expect(pageMisses(r, THRESHOLDS)).toEqual(["mobile performance: no score"]);
  });

  it("fails on axe violations and run-time errors", () => {
    const r = result({
      axe: [{ id: "color-contrast", impact: "serious", help: "Elements must meet contrast", nodes: 2 }],
      errors: ["expected HTTP 200, got 500"],
    });
    expect(pageMisses(r, THRESHOLDS)).toEqual([
      "expected HTTP 200, got 500",
      "axe serious color-contrast (2 nodes): Elements must meet contrast",
    ]);
  });
});

describe("failingViolations", () => {
  it("keeps only serious and critical, and counts nodes", () => {
    const out = failingViolations([
      { id: "a", impact: "minor", help: "A", nodes: [{ target: ["h1"] }] },
      { id: "b", impact: "moderate", help: "B", nodes: [{ target: ["p"] }] },
      { id: "c", impact: "serious", help: "C", nodes: [{ target: ["a"] }, { target: ["b"] }] },
      { id: "d", impact: "critical", help: "D", nodes: [] },
      { id: "e", impact: null, help: "E", nodes: [{ target: ["x"] }] },
    ]);
    expect(out).toEqual([
      { id: "c", impact: "serious", help: "C", nodes: 2 },
      { id: "d", impact: "critical", help: "D", nodes: 0 },
    ]);
  });
});

describe("summarise and formatTable", () => {
  it("splits pass from fail and prints a row per page", () => {
    const pass = result();
    const fail = result({ name: "login", path: "/login", lighthouse: { mobile: { performance: 50, accessibility: 100, "best-practices": 100, seo: 100 } } });
    const s = summarise([pass, fail], THRESHOLDS);
    expect(s.passed.map((r) => r.name)).toEqual(["home"]);
    expect(s.failed.map((f) => f.result.name)).toEqual(["login"]);
    expect(s.failed[0]?.misses).toEqual(["mobile performance: 50 < 80"]);

    const table = formatTable([pass, fail], THRESHOLDS);
    const lines = table.split("\n");
    expect(lines[2]).toMatch(/^home\s+\/\s+ 90 100 100 100\s+ 99 100 100 100\s+ok\s+PASS$/);
    expect(lines[3]).toMatch(/^login\s+\/login\s+ 50 100 100 100\s+–\s+–\s+–\s+–\s+ok\s+FAIL$/);
    expect(table).toContain("performance ≥ 80");
  });
});

describe("sitemap-derived page selection", () => {
  const paths = [
    "/", "/cities", "/categories", "/pricing", "/privacy", "/terms",
    "/blog/how-to-read-a-quote",
    "/leeds", "/york", "/bath",
    "/categories/barns", "/categories/hotels",
    "/leeds/the-mill", "/leeds/old-hall", "/york/minster-rooms",
  ];
  const sitemap = classifySitemapPaths(paths);

  it("tells cities from static routes by whether a listing lives under them", () => {
    expect(sitemap.cities).toEqual(["/leeds", "/york"]);
    expect(sitemap.categories).toEqual(["/categories/barns", "/categories/hotels"]);
    expect(sitemap.listings).toEqual(["/leeds/the-mill", "/leeds/old-hall", "/york/minster-rooms"]);
    expect(sitemap.statics).toContain("/bath");
    expect(sitemap.statics).toContain("/blog/how-to-read-a-quote");
    expect(sitemap.statics).not.toContain("/leeds");
  });

  it("picks the city with the most listings, ties broken alphabetically", () => {
    expect(busiestCity(sitemap)).toBe("leeds");
    expect(busiestCity(classifySitemapPaths(["/b/x", "/a/y"]))).toBe("a");
    expect(busiestCity(classifySitemapPaths([]))).toBeNull();
  });

  it("finds a city+category link the pillar renders, ignoring unknown slugs", () => {
    const html = '<a href="/leeds/the-mill">x</a> <a href="/leeds/page/2">2</a> <a href="/leeds/hotels">h</a>';
    expect(cityCategoryPathFromHtml(html, "leeds", ["barns", "hotels"])).toBe("/leeds/hotels");
    expect(cityCategoryPathFromHtml(html, "york", ["barns", "hotels"])).toBeNull();
  });

  it("reads the listing id off the report link", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(listingIdFromHtml(`<a href="/report/${id}">Report</a>`)).toBe(id);
    expect(listingIdFromHtml("<p>no links</p>")).toBeNull();
  });

  it("builds the page list from what it was given and skips what it cannot derive", () => {
    const full = selectPages({ sitemap, cityCategoryPath: "/leeds/hotels", listingId: "abc", hasSecondPage: true });
    const byName = Object.fromEntries(full.pages.map((p) => [p.name, p.path]));
    expect(byName["city pillar"]).toBe("/leeds");
    expect(byName["listing detail"]).toBe("/leeds/the-mill");
    expect(byName["pagination"]).toBe("/leeds/page/2");
    expect(byName["claim"]).toBe("/claim/abc");
    expect(byName["blog post"]).toBe("/blog/how-to-read-a-quote");
    expect(byName["search"]).toBe("/search?q=leeds");
    expect(full.pages.find((p) => p.name === "404")?.expectStatus).toBe(404);
    expect(full.skipped).toEqual([]);

    const bare = selectPages({ sitemap: classifySitemapPaths(["/"]), cityCategoryPath: null, listingId: null, hasSecondPage: false });
    expect(bare.pages.map((p) => p.name)).not.toContain("city pillar");
    expect(bare.skipped.length).toBeGreaterThan(0);
    expect(bare.skipped.some((s) => s.startsWith("pagination"))).toBe(true);
  });

  it("filters by name when AUDIT_PAGES is set", () => {
    const pages = [{ name: "home" }, { name: "Login" }, { name: "terms" }];
    expect(filterPages(pages, "home, login").map((p) => p.name)).toEqual(["home", "Login"]);
    expect(filterPages(pages, undefined)).toBe(pages);
  });
});
