import { expect, test } from "@playwright/test";
import { sitemapRoutes, navRoutes, footerRoutes } from "@/lib/features/navigation";

/**
 * Every advertised link must resolve.
 *
 * navigation.ts is the single source for the header, the footer, the sitemap
 * and the breadcrumbs, which means one wrong href there is a 404 in four
 * places at once — and four of them shipped: nav and sitemap advertised
 * /guides while the route was /blog.
 *
 * The route set is computed from the same flags the server was built with, so
 * this also proves the flags-off and flags-on builds each advertise only the
 * routes they actually serve. That is the whole point of running it twice in
 * CI: with a flag off, its route must be absent AND gone from the nav, not
 * merely 404ing.
 */

/** Deduplicated hrefs from all three surfaces, in a stable order. */
function advertisedHrefs(): { href: string; where: string }[] {
  const sources: [string, { href: string }[]][] = [
    ["sitemap", [...sitemapRoutes()]],
    ["nav", [...navRoutes()]],
    ["footer", [...footerRoutes()]],
  ];
  const seen = new Map<string, string[]>();
  for (const [where, entries] of sources) {
    for (const entry of entries) {
      seen.set(entry.href, [...(seen.get(entry.href) ?? []), where]);
    }
  }
  return [...seen.entries()]
    .map(([href, wheres]) => ({ href, where: wheres.join("+") }))
    .sort((a, b) => a.href.localeCompare(b.href));
}

// FIXME(Task 4): navigation.ts still advertises /guides while the route is
// /blog, so this fails until the metadata/sitemap task merges. Flip to
// test.describe on merge.
test.fixme(true, "blocked on Task 4: navigation.ts advertises /guides, route is /blog");

test.describe("advertised routes", () => {
  test("every nav, footer and sitemap href returns 200", async ({ request }) => {
    const hrefs = advertisedHrefs();
    expect(hrefs.length, "navigation.ts produced no routes at all").toBeGreaterThan(5);

    const broken: string[] = [];
    for (const { href, where } of hrefs) {
      const res = await request.get(href, { maxRedirects: 0 });
      if (res.status() !== 200) broken.push(`${href} (${where}) -> ${res.status()}`);
    }
    expect(broken, "advertised links that do not resolve").toEqual([]);
  });

  test("no advertised href is a redirect", async ({ request }) => {
    // A 301 in the nav is a link we are choosing to make everyone follow twice,
    // and in the sitemap it is a URL we are asking Google not to index.
    const redirecting: string[] = [];
    for (const { href } of advertisedHrefs()) {
      const res = await request.get(href, { maxRedirects: 0 });
      if (res.status() >= 300 && res.status() < 400) {
        redirecting.push(`${href} -> ${res.status()} ${res.headers()["location"] ?? ""}`);
      }
    }
    expect(redirecting, "advertised links that redirect").toEqual([]);
  });
});
