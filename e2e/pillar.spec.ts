import { expect, test } from "@playwright/test";
import { paginatingCity } from "./fixtures";

let CITY: string;
let CITY_NAME: string;
test.beforeAll(async () => {
  const city = await paginatingCity();
  CITY = city.path;
  CITY_NAME = city.name;
});

test.describe("city pillar page", () => {
  test("renders the heading, the listing grid and the internal-linking blocks", async ({ page }) => {
    const response = await page.goto(CITY);
    expect(response?.status(), "pillar page must return 200").toBe(200);

    // One h1, and it names the place.
    const h1 = page.locator("h1");
    await expect(h1).toHaveCount(1);
    await expect(h1).toContainText(new RegExp(CITY_NAME, "i"));

    // The grid is the page. An empty grid is a dead pillar page.
    const cards = page.locator('[data-testid="listing-grid"] > li');
    const cardCount = await cards.count();
    expect(cardCount, "pillar page must render at least one listing").toBeGreaterThan(0);

    // Every card links somewhere real under this city.
    const firstHref = await cards.first().locator("a").first().getAttribute("href");
    expect(firstHref).toMatch(new RegExp(`^${CITY}/[a-z0-9-]+$`));

    // The two blocks that make a directory a graph rather than a pile of orphans.
    const categories = page.locator('[data-testid="category-links"]');
    await expect(categories, "category sub-links block must be present").toBeVisible();
    expect(await categories.locator("li a").count()).toBeGreaterThan(0);

    const nearby = page.locator('[data-testid="nearby-cities"]');
    await expect(nearby, "nearby-cities block must be present").toBeVisible();
    expect(await nearby.locator("li a").count()).toBeGreaterThan(0);
  });

  test("nearby-city links resolve to real pages", async ({ page, request }) => {
    await page.goto(CITY);
    const href = await page
      .locator('[data-testid="nearby-cities"] li a')
      .first()
      .getAttribute("href");
    expect(href).toBeTruthy();

    const res = await request.get(href!);
    expect(res.status(), `nearby link ${href} must not be broken`).toBe(200);
  });
});
