import { expect, test, type Page } from "@playwright/test";
import { siteConfig } from "@/config/site.config";
import { paginatingCity } from "./fixtures";

let CITY: string;
test.beforeAll(async () => {
  CITY = (await paginatingCity()).path;
});

/**
 * The right @type on the right page.
 *
 * e2e/jsonld.spec.ts already proves every block parses and that nothing
 * fabricates a rating. It does not prove the graph says anything useful: a
 * listing page emitting only a WebSite node parses perfectly and tells Google
 * nothing about the listing.
 */

async function typesOn(page: Page, path: string): Promise<Set<string>> {
  const response = await page.goto(path);
  expect(response?.status(), `${path} did not render`).toBe(200);

  const blocks = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
    nodes.map((n) => n.textContent ?? ""),
  );
  expect(blocks.length, `${path} ships no JSON-LD`).toBeGreaterThan(0);

  const types = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "@type") {
        for (const t of Array.isArray(value) ? value : [value]) {
          if (typeof t === "string") types.add(t);
        }
      }
      walk(value);
    }
  };
  for (const raw of blocks) walk(JSON.parse(raw));
  return types;
}

test.describe("JSON-LD @type per page type", () => {
  test("a city pillar is a CollectionPage with an ItemList and breadcrumbs", async ({ page }) => {
    const types = await typesOn(page, CITY);
    for (const required of ["CollectionPage", "ItemList", "BreadcrumbList"]) {
      expect([...types], `pillar page is missing ${required}`).toContain(required);
    }
  });

  test("a city-category page is a CollectionPage with an ItemList and breadcrumbs", async ({ page }) => {
    await page.goto(CITY);
    const href = await page
      .locator('[data-testid="category-links"] li a')
      .first()
      .getAttribute("href");
    expect(href, "no city-category page to sample").toBeTruthy();

    const types = await typesOn(page, href!);
    for (const required of ["CollectionPage", "ItemList", "BreadcrumbList"]) {
      expect([...types], `${href} is missing ${required}`).toContain(required);
    }
  });

  test("a listing carries the schema type the config names", async ({ page }) => {
    await page.goto(CITY);
    const href = await page
      .locator('[data-testid="listing-grid"] > li a')
      .first()
      .getAttribute("href");
    expect(href, "no listing to sample").toBeTruthy();

    const types = await typesOn(page, href!);
    // Config-driven, not hardcoded: a plumber clone sets schema.listingType to
    // LocalBusiness and this assertion follows it.
    expect([...types], `${href} does not emit ${siteConfig.schema.listingType}`)
      .toContain(siteConfig.schema.listingType);
    expect([...types], `${href} has no breadcrumbs`).toContain("BreadcrumbList");
  });

  test("a blog post is a BlogPosting", async ({ page }) => {
    await page.goto("/blog");
    const href = await page.locator("main a[href^='/blog/']").first().getAttribute("href");
    if (!href) {
      test.skip(true, "no blog post to sample: this site ships without posts");
      return;
    }

    const types = await typesOn(page, href);
    expect([...types], `${href} is not typed as a BlogPosting`).toContain("BlogPosting");
  });
});
