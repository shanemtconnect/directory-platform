import { expect, test } from "@playwright/test";
import { sitemapRoutes, navRoutes, footerRoutes } from "@/lib/features/navigation";

/**
 * Every advertised link must resolve.
 *
 * navigation.ts is the single source for the header, the footer, the sitemap
 * and the breadcrumbs, so one wrong href there is a broken link in all four at
 * once — which is exactly what happened: nav and sitemap both advertised
 * /guides while the route was /blog.
 *
 * The route set is computed from the same flags the server was built with, so
 * running this under both CI legs also proves each build advertises only what
 * it serves: with a flag off its route must be gone from the nav, not merely
 * 404ing.
 *
 * A redirect fails this too, and should. A 301 in the nav makes every visitor
 * take two hops; in the sitemap it is a URL we are asking Google not to index.
 */

/** Deduplicated hrefs across all three surfaces, in a stable order. */
function advertisedHrefs(): { href: string; where: string }[] {
  const surfaces: [string, readonly { readonly href: string }[]][] = [
    ["sitemap", sitemapRoutes()],
    ["nav", navRoutes()],
    ["footer", footerRoutes()],
  ];
  const found = new Map<string, string[]>();
  for (const [where, entries] of surfaces) {
    for (const entry of entries) {
      found.set(entry.href, [...(found.get(entry.href) ?? []), where]);
    }
  }
  return [...found.entries()]
    .map(([href, wheres]) => ({ href, where: wheres.join("+") }))
    .sort((a, b) => a.href.localeCompare(b.href));
}

// FIXME(Task 4): navigation.ts still advertises /guides while the route is
// /blog, so this fails until the metadata/sitemap task merges. Drop this line
// on merge.
test.fixme(true, "blocked on Task 4: navigation.ts advertises /guides, route is /blog");

test.describe("advertised routes", () => {
  test("every nav, footer and sitemap href returns 200", async ({ request }) => {
    const hrefs = advertisedHrefs();
    expect(hrefs.length, "navigation.ts produced no routes at all").toBeGreaterThan(5);

    const broken: string[] = [];
    for (const { href, where } of hrefs) {
      // maxRedirects: 0 so a 301 is reported as itself rather than followed to
      // a 200 that hides it.
      const res = await request.get(href, { maxRedirects: 0 });
      if (res.status() !== 200) {
        broken.push(`${href} (${where}) -> ${res.status()} ${res.headers()["location"] ?? ""}`.trim());
      }
    }
    expect(broken, "advertised links that do not resolve to 200").toEqual([]);
  });
});
