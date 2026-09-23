import { expect, test, type Page } from "@playwright/test";
import { narrowingKeyword, paginatingCity } from "./fixtures";

async function resultCount(page: Page): Promise<number> {
  const text = (await page.locator('[data-testid="result-count"]').textContent()) ?? "";
  const match = text.replace(/,/g, "").match(/\d+/);
  expect(match, `result count not found in "${text}"`).toBeTruthy();
  return Number(match![0]);
}

let CITY: string;
let KEYWORD: string;
test.beforeAll(async () => {
  CITY = (await paginatingCity()).slug;
  KEYWORD = await narrowingKeyword();
});

test.describe("search", () => {
  test("unfiltered search shows a result count", async ({ page }) => {
    const res = await page.goto("/search");
    expect(res?.status()).toBe(200);

    await expect(page.locator('[data-testid="result-count"]')).toBeVisible();
    const total = await resultCount(page);
    expect(total, "unfiltered search must find listings").toBeGreaterThan(0);

    await expect(page.locator('[data-testid="search-results"] > li').first()).toBeVisible();
  });

  test("a keyword narrows the result set", async ({ page }) => {
    await page.goto("/search");
    const all = await resultCount(page);

    await page.goto(`/search?q=${encodeURIComponent(KEYWORD)}`);
    const filtered = await resultCount(page);

    expect(filtered, "the keyword must match something").toBeGreaterThan(0);
    expect(filtered, `?q=${KEYWORD} must return fewer results than an unfiltered search`).toBeLessThan(all);

    // The count has to agree with what is on the page, not just be a number.
    const shown = await page.locator('[data-testid="search-results"] > li').count();
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(filtered);
  });

  test("the city facet narrows the result set further", async ({ page }) => {
    await page.goto("/search");
    const all = await resultCount(page);

    await page.goto(`/search?city=${CITY}`);
    const inCity = await resultCount(page);

    expect(inCity).toBeGreaterThan(0);
    expect(inCity).toBeLessThan(all);

    // Every result really is in that city.
    const links = await page.$$eval('[data-testid="search-results"] li a', (as) =>
      as.map((a) => a.getAttribute("href") ?? ""),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      expect(href).toMatch(new RegExp(`^/${CITY}/`));
    }
  });

  test("search stays out of the index", async ({ page }) => {
    await page.goto("/search");
    // Faceted URLs must never compete with the pillar pages they feed.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
  });
});
