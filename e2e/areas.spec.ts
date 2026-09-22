import { expect, test, type Page } from "@playwright/test";
import { siteConfig } from "@/config/site.config";
import { slugify } from "@/lib/routing/slugify";
import { withE2eDb } from "./database";

/**
 * The region pages: /areas and /areas/<region>.
 *
 * Nothing here names a county. The region under test is the one the seed made
 * busiest among those with an indexable city — read from the database the
 * server is serving, as every fixture in this suite is.
 */
interface RegionRow { region: string; cities: number }

let REGION: string;
let REGION_PATH: string;
test.beforeAll(async () => {
  const [row] = await withE2eDb((sql) =>
    sql.unsafe<RegionRow[]>(`
      select c.region, count(*)::int as cities
      from cities c
      where c.is_published and c.is_indexable and c.region is not null
      group by c.region
      order by cities desc, c.region
      limit 1
    `),
  );
  if (!row) throw new Error("The e2e database has no indexable city with a region.");
  REGION = row.region;
  REGION_PATH = `/areas/${slugify(row.region)}`;
});

const PERMANENT = 308;

async function jsonLdTypes(page: Page): Promise<string[]> {
  const blobs = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
    nodes.map((n) => n.textContent ?? ""),
  );
  return blobs.map((b) => (JSON.parse(b) as { "@type": string })["@type"]);
}

test.describe("/areas", () => {
  test("renders the region index with a breadcrumb and a link to the region", async ({ page }) => {
    const res = await page.goto("/areas");
    expect(res?.status()).toBe(200);
    await expect(page.locator('nav[aria-label="Breadcrumb"]')).toBeVisible();
    await expect(page.locator(`[data-testid="region-list"] a[href="${REGION_PATH}"]`)).toHaveText(REGION);
    expect(await jsonLdTypes(page)).toEqual(expect.arrayContaining(["BreadcrumbList", "CollectionPage"]));
    // It has earned indexing: at least one region on it has.
    expect(res?.headers()["x-robots-tag"] ?? "").not.toMatch(/noindex/);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  });

  test("is linked from the footer", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('footer a[href="/areas"]')).toHaveCount(1);
  });
});

test.describe("/areas/<region>", () => {
  test("renders the pillar: three-crumb trail, the city grid, the listings and its JSON-LD", async ({ page }) => {
    const res = await page.goto(REGION_PATH);
    expect(res?.status()).toBe(200);

    const crumbs = page.locator('nav[aria-label="Breadcrumb"] a');
    await expect(crumbs).toHaveCount(2);
    await expect(crumbs.nth(0)).toHaveAttribute("href", "/");
    await expect(crumbs.nth(1)).toHaveAttribute("href", "/areas");
    await expect(page.locator("h1")).toHaveText(`${siteConfig.entity.Plural} in ${REGION}`);

    const grid = page.locator('[data-testid="region-city-grid"]');
    await expect(grid).toBeVisible();
    expect(await grid.locator("a[href]").count()).toBeGreaterThan(0);

    await expect(page.locator('[data-testid="listing-grid"] li').first()).toBeVisible();
    expect(await jsonLdTypes(page)).toEqual(expect.arrayContaining(["BreadcrumbList", "CollectionPage"]));
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`${REGION_PATH}$`));
  });

  test("never puts the region in a listing URL", async ({ page }) => {
    await page.goto(REGION_PATH);
    const hrefs = await page.$$eval('[data-testid="listing-grid"] a[href]', (as) =>
      as.map((a) => a.getAttribute("href") ?? ""),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).not.toMatch(/^\/areas\//);
    for (const href of hrefs) expect(href).toMatch(/^\/[^/]+\/[^/]+$/);
  });

  test("/page/1 308s to the bare page; mixed case 308s to lowercase; past the end 404s", async ({ request }) => {
    const one = await request.get(`${REGION_PATH}/page/1`, { maxRedirects: 0 });
    expect(one.status()).toBe(PERMANENT);
    expect(new URL(one.headers()["location"]!, "http://x").pathname).toBe(REGION_PATH);

    const mixed = await request.get(REGION_PATH.toUpperCase(), { maxRedirects: 0 });
    expect(mixed.status()).toBe(PERMANENT);
    expect(new URL(mixed.headers()["location"]!, "http://x").pathname).toBe(REGION_PATH);

    expect((await request.get(`${REGION_PATH}/page/999`, { maxRedirects: 0 })).status()).toBe(404);
    expect((await request.get(`/areas/no-such-${Date.now()}`, { maxRedirects: 0 })).status()).toBe(404);
  });
});
