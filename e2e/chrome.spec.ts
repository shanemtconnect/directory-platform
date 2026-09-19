import { expect, test, type Page } from "@playwright/test";
import { paginatingCity } from "./fixtures";

let CITY: string;
test.beforeAll(async () => {
  CITY = (await paginatingCity()).path;
});

/**
 * The header and footer are on every page, including the ones nobody meant to
 * render.
 *
 * A 404 without the site chrome is a dead end: no nav, no footer links, no way
 * back into the site for a visitor who followed a stale link, and nothing for a
 * crawler to follow either.
 */

async function chromeOn(page: Page, path: string, expectedStatus = 200): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), `${path} returned ${response?.status()}`).toBe(expectedStatus);

  const header = page.locator("header").first();
  await expect(header, `${path} has no <header>`).toBeVisible();
  expect(
    await header.locator("nav a").count(),
    `${path} renders a header with no navigation links`,
  ).toBeGreaterThan(0);

  const footer = page.locator("footer").first();
  await expect(footer, `${path} has no <footer>`).toBeVisible();
  expect(
    await footer.locator("a").count(),
    `${path} renders a footer with no links`,
  ).toBeGreaterThan(0);
}

test.describe("site chrome", () => {
  test("every page type renders the header and the footer", async ({ page }) => {
    await page.goto(CITY);
    const listing = await page
      .locator('[data-testid="listing-grid"] > li a')
      .first()
      .getAttribute("href");
    const category = await page
      .locator('[data-testid="category-links"] li a')
      .first()
      .getAttribute("href");
    expect(listing, "no listing to sample").toBeTruthy();
    expect(category, "no city-category page to sample").toBeTruthy();

    for (const path of [
      "/",
      "/cities",
      "/categories",
      "/search",
      "/pricing",
      "/blog",
      CITY,
      `${CITY}/page/2`,
      category!,
      listing!,
    ]) {
      await chromeOn(page, path);
    }
  });

  test("the 404 page keeps the header and the footer", async ({ page }) => {
    await chromeOn(page, "/this-city-does-not-exist", 404);
  });

  test("the 404 page says so rather than rendering an empty shell", async ({ page }) => {
    const response = await page.goto("/this-city-does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.locator("main h1")).toBeVisible();
  });
});
