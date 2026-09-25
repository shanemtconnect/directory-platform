import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { assignNeighbourhoods } from "@/lib/db/queries/neighbourhoods";
import { siteConfig } from "@/config/site.config";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { TestDb } from "@/lib/db/types";
import { E2E_DATABASE_URL } from "./database";
import { sideCity, type CityFixture } from "./fixtures";

/**
 * Neighbourhoods under towns (Task 52), end to end: an admin imports two
 * neighbourhoods for `sideCity()` through /admin/neighbourhoods, the
 * assignment runs (straight against the e2e database, as the worker would —
 * the suite runs no worker), and then the public side: the neighbourhood
 * page with its breadcrumb and listings, `noindex` below the threshold and
 * absent from the sitemap, and the town page's "Neighbourhoods" block
 * linking only the one that has listings. The publish toggle is exercised
 * on the way, and it is also what busts the ISR-cached town page.
 *
 * Needs the module on: run with NEIGHBOURHOODS_ENABLED=true (the template
 * config has it off). Everything written is removed at the end, and every
 * listing's coordinates are put back.
 */

const ON = process.env.NEIGHBOURHOODS_ENABLED === "true";
const PASSWORD = "not-a-real-password";
const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
/** A spot on the map far from anything real, so no seeded listing is near it by accident. */
const A = { name: `Nbhd A ${STAMP}`, slug: `nbhd-a-${STAMP}`, lat: 10, lng: 10 };
const B = { name: `Nbhd B ${STAMP}`, slug: `nbhd-b-${STAMP}`, lat: 10.2, lng: 10.2 };
/**
 * At most this many of the town's listings are placed inside A: below the
 * index threshold, so the page is noindexed. `sideCity()` is one of the
 * quietest towns, so it may have fewer — one is enough.
 */
const MAX_PLACED = Math.min(2, siteConfig.geo.neighbourhoods.minListings - 1);

interface Moved { id: string; name: string; lat: number | null; lng: number | null }

let TOWN: CityFixture;
let moved: Moved[] = [];

async function withSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function signUpAdmin(page: Page): Promise<void> {
  const email = `nbhd-admin-${STAMP}@example.com`;
  await page.goto("/signup");
  const form = page.locator('[data-testid="signup-form"]');
  await form.locator("#name").fill("Playwright Admin");
  await form.locator("#email").fill(email);
  await form.locator("#password").fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL("**/account", { timeout: 15_000 });
  // No UI grants the admin bit, on purpose (see admin.spec.ts).
  await withSql(async (sql) => {
    const [u] = await sql<{ id: string }[]>`select id from "user" where email = ${email} limit 1`;
    await sql`
      insert into profiles (user_id, role) values (${u!.id}, 'admin')
      on conflict (user_id) do update set role = 'admin'
    `;
  });
}

test.describe("neighbourhoods", () => {
  test.skip(!ON, "geo.neighbourhoods is off in this build (set NEIGHBOURHOODS_ENABLED=true)");

  test.beforeAll(async () => {
    if (!ON) return;
    TOWN = await sideCity();
    moved = await withSql((sql) => sql<Moved[]>`
      select id, name, lat, lng from listings
      where city_id = (select id from cities where slug = ${TOWN.slug})
        and status = 'published' and source = 'seed'
        -- featured.spec.ts inserts (and then deletes) its own "seed" listings
        -- in this same town, slugged e2e-featured-*; one of those vanishing
        -- mid-test is not a neighbourhood bug.
        and slug not like 'e2e-%'
      order by slug limit ${MAX_PLACED}
    `);
    if (moved.length === 0) throw new Error(`${TOWN.slug} has no published listing to place`);
    // Inside A's 1 km radius, about 100 m from its centroid.
    for (const l of moved) {
      await withSql((sql) => sql`update listings set lat = ${A.lat + 0.001}, lng = ${A.lng} where id = ${l.id}`);
    }
  });

  test.afterAll(async () => {
    if (!ON) return;
    await withSql(async (sql) => {
      for (const l of moved) {
        await sql`update listings set lat = ${l.lat}, lng = ${l.lng}, area_id = null where id = ${l.id}`;
      }
      const ids = await sql<{ id: string }[]>`select id from areas where slug in (${A.slug}, ${B.slug})`;
      for (const { id } of ids) {
        await sql`update listings set area_id = null where area_id = ${id}`;
        await sql`delete from slugs where kind = 'area' and entity_id = ${id}`;
        await sql`delete from areas where id = ${id}`;
      }
      await sql`delete from job_queue where kind = 'neighbourhoods.assign' and status = 'pending'`;
    });
  });

  test("import, assign, publish: the page, its breadcrumb and list, noindex below the threshold", async ({ page }) => {
    await signUpAdmin(page);

    // --- the admin imports two neighbourhoods for the town ---------------
    await page.goto("/admin/neighbourhoods");
    await expect(page.locator('[data-testid="admin-nav"] a[href="/admin/neighbourhoods"]')).toBeVisible();
    await page.locator('[data-testid="import-csv"]').fill(
      "city_slug,name,slug,lat,lng,radius_km\n" +
        `${TOWN.slug},${A.name},${A.slug},${A.lat},${A.lng},1\n` +
        `${TOWN.slug},${B.name},${B.slug},${B.lat},${B.lng},1\n` +
        `no-such-town-${STAMP},Nowhere,nowhere-${STAMP},10,10,1\n`,
    );
    await page.locator('[data-testid="import-submit"]').click();
    await expect(page.locator('[data-testid="import-done"]')).toContainText("2 created");
    await expect(page.locator('[data-testid="import-problems"]')).toContainText("Line 4");

    // "Assign listings now" queues a run for the worker...
    await page.locator('[data-testid="assign-submit"]').click();
    await expect(page.locator('[data-testid="assign-done"]')).toBeVisible();
    const queued = await withSql((sql) => sql`select 1 from job_queue where kind = 'neighbourhoods.assign' and status = 'pending'`);
    expect(queued.length).toBeGreaterThan(0);

    // ...which is what the worker then does. There is no worker in this suite.
    const outcome = await withSql(async (sql) => {
      const db = drizzle(sql, { schema }) as unknown as TestDb;
      return assignNeighbourhoods(db, ADMIN_VIEWER);
    });
    expect(outcome.cities).toBeGreaterThan(0);
    const placed = await withSql((sql) => sql<{ n: number }[]>`
      select count(*)::int as n from listings l join areas a on a.id = l.area_id
      where a.slug = ${A.slug} and l.id in ${sql(moved.map((m) => m.id))}
    `);
    expect(placed[0]!.n).toBe(moved.length);

    // --- the publish toggle, which also busts the cached town page ------
    await page.reload();
    const rowA = page.locator(`[data-testid="neighbourhood-${A.slug}"]`);
    await expect(rowA.locator('td[data-label="Listings"]')).toContainText(String(moved.length));
    await rowA.locator(`[data-testid="publish-${A.slug}"]`).click();
    await expect(rowA.locator('[data-testid$="-done"]')).toContainText("Unpublished");
    expect((await page.goto(`/${TOWN.slug}/${A.slug}`))?.status()).toBe(404);

    await page.goto("/admin/neighbourhoods");
    await page.locator(`[data-testid="neighbourhood-${A.slug}"] [data-testid="publish-${A.slug}"]`).click();
    await expect(page.locator(`[data-testid="neighbourhood-${A.slug}"] [data-testid$="-done"]`)).toContainText("Published");

    // --- the neighbourhood page ------------------------------------------
    const res = await page.goto(`/${TOWN.slug}/${A.slug}`);
    expect(res?.status()).toBe(200);
    const crumb = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(crumb.locator(`a[href="/${TOWN.slug}"]`)).toHaveText(TOWN.name);
    await expect(crumb).toContainText(A.name);
    await expect(page.locator("h1")).toContainText(A.name);
    const grid = page.locator('[data-testid="listing-grid"]');
    for (const l of moved) await expect(grid).toContainText(l.name);
    // The town's by-type block (town-wide links and counts) is not repeated here.
    await expect(page.locator('[data-testid="category-links"]')).toHaveCount(0);
    // Below geo.neighbourhoods.minListings: noindex, and not in the sitemap.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    const collection = ld.map((t) => JSON.parse(t) as Record<string, unknown>)
      .find((d) => d["@type"] === "CollectionPage");
    expect(collection?.["about"]).toMatchObject({
      "@type": "Place", name: A.name, containedInPlace: { "@type": "City", name: TOWN.name },
    });

    const sitemap = await (await page.request.get("/sitemaps/sitemap/static+cities.xml")).text();
    // A real shard, so the negative below is not vacuous.
    expect(sitemap).toContain("<urlset");
    expect(sitemap).toContain("<loc>");
    expect(sitemap).not.toContain(`/${TOWN.slug}/${A.slug}`);

    // --- the town page lists A (it has listings) and not B (it has none) --
    await page.goto(TOWN.path);
    const block = page.locator('[data-testid="neighbourhood-links"]');
    await expect(block.locator(`a[href="/${TOWN.slug}/${A.slug}"]`)).toBeVisible();
    await expect(block).toContainText(`(${moved.length})`);
    await expect(block.locator(`a[href="/${TOWN.slug}/${B.slug}"]`)).toHaveCount(0);
  });
});
