import { expect, test, type Page } from "@playwright/test";

/**
 * Canonicals must be absolute and point at this origin.
 *
 * A relative `href="/pricing"` is what a missing `metadataBase` produces, and
 * Google treats a relative canonical as a hint it may quietly ignore. Pages
 * with no canonical at all leave the choice of URL to a crawler that has also
 * seen `/leeds/page/1`, `/Leeds` and `?utm_source=...`.
 */

const BASE = "http://localhost:3200";

async function canonicalOf(page: Page, path: string): Promise<string> {
  const response = await page.goto(path);
  expect(response?.status(), `${path} did not render`).toBe(200);
  const href = await page.locator('link[rel="canonical"]').first().getAttribute("href");
  expect(href, `${path} has no <link rel="canonical">`).toBeTruthy();
  return href!;
}

/** One representative URL of each page type that has its own canonical. */
async function samplePaths(page: Page): Promise<Record<string, string>> {
  await page.goto("/richmond-north-yorkshire");
  const listing = await page
    .locator('[data-testid="listing-grid"] > li a')
    .first()
    .getAttribute("href");
  expect(listing, "no listing to sample").toBeTruthy();

  const category = await page
    .locator('[data-testid="category-links"] li a')
    .first()
    .getAttribute("href");
  expect(category, "no city-category page to sample").toBeTruthy();

  await page.goto("/categories");
  const nationalCategory = await page
    .locator("main a[href^='/categories/']")
    .first()
    .getAttribute("href");
  expect(nationalCategory, "no /categories/<x> page to sample").toBeTruthy();

  return {
    home: "/",
    pillar: "/richmond-north-yorkshire",
    cityCategory: category!,
    listing: listing!,
    pricing: "/pricing",
    nationalCategory: nationalCategory!,
  };
}

// FIXME(Task 4): there is no metadataBase and no canonical on home, pillar,
// listing or category pages yet, and /pricing's is relative. Flip to
// test.describe once the metadata task merges.
test.fixme(true, "blocked on Task 4: metadataBase and per-page canonicals");

test.describe("canonical URLs", () => {
  test("every page type carries an absolute canonical on this origin", async ({ page }) => {
    const paths = await samplePaths(page);

    for (const [kind, path] of Object.entries(paths)) {
      const href = await canonicalOf(page, path);
      expect(href, `${kind} (${path}) canonical is relative`).toMatch(/^https?:\/\//);
      expect(href, `${kind} (${path}) canonical points off-origin: ${href}`).toContain(BASE);
      expect(new URL(href).origin, `${kind} (${path})`).toBe(BASE);
    }
  });

  test("a page's canonical is its own URL, not a parent's", async ({ page }) => {
    const paths = await samplePaths(page);

    for (const [kind, path] of Object.entries(paths)) {
      const href = await canonicalOf(page, path);
      const expected = path === "/" ? "" : path;
      expect(new URL(href).pathname.replace(/\/$/, ""), `${kind} (${path})`).toBe(expected);
    }
  });

  test("page 2 of a pillar canonicalises to page 2, not to page 1", async ({ page }) => {
    // Self-canonicalising a paginated page to page 1 hides pages 2..N from the
    // index while still spending the crawl on them.
    const href = await canonicalOf(page, "/richmond-north-yorkshire/page/2");
    expect(new URL(href).pathname).toBe("/richmond-north-yorkshire/page/2");
  });
});
