import { expect, test, type Page } from "@playwright/test";

/**
 * Non-negotiable project requirement: pagination must be crawlable.
 *
 * GeoDirectory-style `javascript:void(0)` pagination makes pages 2+ of every
 * listing set invisible to crawlers. Every paginated link on this site has to
 * be a real <a href> pointing at a real, server-rendered URL that returns 200.
 *
 * Note on the seed data: no seeded city exceeds PER_PAGE (24) — the largest is
 * Richmond with 11 — so the pillar pages legitimately render no pagination nav.
 * The link-level assertions therefore run against /search, which has all 200
 * listings and does paginate, while the path-pagination assertion hits
 * /<city>/page/2 directly to prove it is a real server route and not a JS one.
 */

const CRAWLED = [
  "/",
  "/richmond-north-yorkshire",
  "/cities",
  "/categories",
  "/search",
];

async function hrefsOnPage(page: Page): Promise<string[]> {
  return page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""));
}

test.describe("pagination is crawlable", () => {
  for (const path of CRAWLED) {
    test(`no javascript: hrefs on ${path}`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status(), `${path} must return 200`).toBe(200);

      const hrefs = await hrefsOnPage(page);
      expect(hrefs.length, `${path} should contain links at all`).toBeGreaterThan(0);

      const bad = hrefs.filter((h) => /^\s*javascript:/i.test(h));
      expect(bad, `javascript: hrefs found on ${path}`).toEqual([]);

      // A bare "#" href on a pagination control is the same disease wearing a
      // different coat: it moves the navigation into JavaScript.
      const paginationHrefs = await page.$$eval(
        '[data-testid="pagination"] a[href]',
        (as) => as.map((a) => a.getAttribute("href") ?? ""),
      );
      const inert = paginationHrefs.filter((h) => h.trim() === "" || h.trim() === "#");
      expect(inert, `inert pagination hrefs on ${path}`).toEqual([]);
    });
  }

  test("search pagination links are real anchors that resolve", async ({ page, request }) => {
    await page.goto("/search");

    const nav = page.locator('[data-testid="pagination"]');
    await expect(
      nav,
      "unfiltered /search holds all 200 listings and must paginate",
    ).toBeVisible();

    const links = nav.locator("a[href]");
    const count = await links.count();
    expect(count, "pagination must expose at least one page link").toBeGreaterThan(0);

    // Every page link must be a genuine, resolvable URL.
    const hrefs: string[] = [];
    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute("href");
      expect(href, "pagination anchor must carry an href").toBeTruthy();
      expect(href!).not.toMatch(/^javascript:/i);
      hrefs.push(href!);
    }

    const pageTwo = hrefs.find((h) => /(\?|&)page=2\b/.test(h) || /\/page\/2$/.test(h));
    expect(pageTwo, "a link to page 2 must exist").toBeTruthy();

    const res = await request.get(pageTwo!);
    expect(res.status(), `${pageTwo} must return 200`).toBe(200);

    // And it must actually be a different page of results, not a re-render of page 1.
    await page.goto(pageTwo!);
    const pageTwoFirst = await page
      .locator('[data-testid="search-results"] li a')
      .first()
      .textContent();
    await page.goto("/search");
    const pageOneFirst = await page
      .locator('[data-testid="search-results"] li a')
      .first()
      .textContent();
    expect(pageTwoFirst).not.toBe(pageOneFirst);
  });

  test("path pagination /<city>/page/2 is a real server-rendered URL", async ({ request }) => {
    const res = await request.get("/richmond-north-yorkshire/page/2");
    expect(res.status(), "/<city>/page/2 must be served, not routed in JS").toBe(200);

    const html = await res.text();
    expect(html).toContain("<h1");
    expect(html, "page 2 must be server-rendered HTML").toMatch(/Richmond/i);
  });

  test("every /page/N anchor found while crawling resolves to 200", async ({ page, request }) => {
    const found = new Set<string>();

    for (const path of CRAWLED) {
      await page.goto(path);
      for (const href of await hrefsOnPage(page)) {
        if (/\/page\/\d+$/.test(href)) found.add(href);
      }
    }

    for (const href of found) {
      expect(href, `${href} must be a path, not a script URL`).toMatch(/^\//);
      const res = await request.get(href);
      expect(res.status(), `${href} must return 200`).toBe(200);
    }
  });
});
