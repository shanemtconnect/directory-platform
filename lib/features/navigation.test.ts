import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildRoutes, sitemapRoutes, navRoutes, footerRoutes } from "./navigation";
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
    expect(hrefs).not.toContain("/shortlist");
  });

  it("never advertises a route that has no route file, under any flags or mode", () => {
    // The "advertised routes exist" suite below checks the CONFIGURED set. This
    // checks every set buildRoutes can produce: a flag whose feature is not
    // built yet must not produce a link to a 404 on the clone that turns it
    // on — which /get-quotes did, and scripts/verify-clone.sh found.
    for (const mode of ["niche-national", "local-multi-vertical"] as const) {
      for (const flags of [allOff, allOn]) {
        for (const { href } of buildRoutes(flags, mode)) {
          expect(routeExists(href, { allowDynamic: false }), `${href} is advertised (${mode}) but has no static route file under app/`).toBe(true);
        }
      }
    }
  });

  it("relabels the content section when contentHub is on, without moving it", () => {
    // /guides has never been a route. The flag renames the section; it does not
    // get to advertise a URL nothing serves.
    const routes = buildRoutes({ ...allOff, contentHub: true }, "niche-national");
    expect(routes.map((r) => r.href)).not.toContain("/guides");
    expect(routes.find((r) => r.href === "/blog")?.label).toBe("Guides");
  });

  it("includes /blog under either setting of contentHub", () => {
    for (const f of [allOff, { ...allOff, contentHub: true }]) {
      expect(buildRoutes(f, "niche-national").map((r) => r.href)).toContain("/blog");
    }
  });

  it("never emits /membership — searcher membership is out of scope permanently", () => {
    expect(buildRoutes(allOn, "niche-national").map((r) => r.href)).not.toContain("/membership");
  });

  it("advertises no /areas in either mode until the page exists", () => {
    // local-multi-vertical has schema and scopes but no pages; a link to
    // /areas was a 404 on any clone that chose the mode.
    for (const mode of ["niche-national", "local-multi-vertical"] as const) {
      expect(buildRoutes(allOff, mode).map((r) => r.href)).not.toContain("/areas");
    }
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

  it("emits the jobs board and the posting page only when jobBoard is on", () => {
    const on = buildRoutes({ ...allOff, jobBoard: true }, "niche-national").map((r) => r.href);
    expect(on).toContain("/jobs");
    expect(on).toContain("/post-a-job");
    const off = buildRoutes(allOff, "niche-national").map((r) => r.href);
    expect(off).not.toContain("/jobs");
    expect(off).not.toContain("/post-a-job");
  });

  it("emits the shortlist route when its flag is on", () => {
    const hrefs = buildRoutes(allOn, "niche-national").map((r) => r.href);
    expect(hrefs).toContain("/shortlist");
  });

  it("does not advertise the unbuilt features even with every flag on", () => {
    const hrefs = buildRoutes(allOn, "niche-national").map((r) => r.href);
    for (const unbuilt of ["/cost", "/get-quotes", "/awards", "/affiliates", "/tools"]) {
      expect(hrefs).not.toContain(unbuilt);
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

/**
 * Every advertised URL must resolve to a real route file.
 *
 * A nav link, a footer link and a sitemap <loc> pointing at a 404 are the same
 * bug wearing three hats, and it stays invisible until a crawler finds it. This
 * walks app/ rather than trusting a hand-written list, so a renamed or deleted
 * route fails here instead of in Search Console.
 */
const ROUTE_FILES = ["page.tsx", "page.ts", "route.ts", "route.tsx"];

function routeExists(
  href: string,
  { allowDynamic, appDir = path.join(process.cwd(), "app") }: {
    allowDynamic: boolean;
    appDir?: string;
  },
): boolean {
  const walk = (dir: string, segments: string[]): boolean => {
    const [head, ...tail] = segments;

    if (head === undefined) {
      return ROUTE_FILES.some((f) => fs.existsSync(path.join(dir, f)));
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    return entries.some((entry) => {
      if (!entry.isDirectory()) return false;
      const name = entry.name;
      // A route group is transparent to the URL, so it consumes no segment.
      if (name.startsWith("(") && name.endsWith(")")) return walk(path.join(dir, name), segments);
      if (name.startsWith("[")) {
        if (!allowDynamic) return false;
        // A catch-all swallows this segment and every one after it.
        const catchAll = name.startsWith("[...") || name.startsWith("[[...");
        return walk(path.join(dir, name), catchAll ? [] : tail);
      }
      return name === head && walk(path.join(dir, name), tail);
    });
  };

  return walk(appDir, href.split("/").filter((s) => s !== ""));
}

describe("advertised routes exist", () => {
  const advertised = [...sitemapRoutes(), ...navRoutes(), ...footerRoutes()];
  const hrefs = [...new Set(advertised.map((r) => r.href))];

  it("has routes to check", () => {
    expect(hrefs.length).toBeGreaterThan(0);
  });

  for (const href of hrefs) {
    // Static, not merely reachable: app/[...segments] matches every path on the
    // site, so accepting a catch-all match here would pass any href at all —
    // including /guides, which the catch-all resolves to a 404.
    it(`${href} has its own route file under app/`, () => {
      expect(routeExists(href, { allowDynamic: false })).toBe(true);
    });
  }

  it("resolves a dynamic segment when one is allowed, and not otherwise", () => {
    const blog = path.join(process.cwd(), "app", "blog");
    expect(routeExists("/anything", { allowDynamic: true, appDir: blog })).toBe(true);
    expect(routeExists("/anything", { allowDynamic: false, appDir: blog })).toBe(false);
  });

  it("rejects a path with no matching directory at all", () => {
    // Rooted at a leaf route so the app-root catch-all cannot answer for it.
    const pricing = path.join(process.cwd(), "app", "pricing");
    expect(routeExists("/definitely-not-a-route", { allowDynamic: true, appDir: pricing })).toBe(false);
  });
});
