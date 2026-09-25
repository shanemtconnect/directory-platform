import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./database";
import { busiestCity } from "./fixtures";
import { PER_PAGE } from "@/lib/db/queries/listings";

/**
 * The verified-only filter (Task 53), end to end, on `busiestCity()`.
 *
 * `busiestCity()` is not guaranteed to hold a verified listing, so this seeds
 * PER_PAGE + 1 of them straight into the database — the same pattern
 * e2e/featured.spec.ts uses for its premium fixture, including the `slugs`
 * row the public route resolves through. PER_PAGE + 1 rather than just one:
 * the spec also proves pagination carries `verified=1`, which needs a real,
 * filtered page 2 regardless of how many OTHER listings the city happens to
 * hold or how many of them are already verified.
 *
 * The CITY page is ISR-cached, and other specs in the same run may have
 * rendered (and cached) it before this seed ran — the toggle's visibility
 * depends on the seed, so a stale cache entry would fail this spec for a
 * reason that has nothing to do with the filter. Busted with
 * /api/internal/revalidate, the same mechanism e2e/featured.spec.ts uses for
 * an identical problem; skipped without the secret, same as there.
 */

const DATABASE_URL = E2E_DATABASE_URL;
const REVALIDATE_SECRET = process.env.INTERNAL_REVALIDATE_SECRET?.trim() ?? "";

interface Seeded {
  cityId: string;
  verticalId: string;
  categoryId: string;
}

async function scaffold(sql: postgres.Sql, citySlug: string): Promise<Seeded> {
  const [city] = await sql<{ id: string }[]>`select id from cities where slug = ${citySlug}`;
  const [cat] = await sql<{ id: string; vertical_id: string }[]>`
    select id, vertical_id from categories where is_active order by sort_order, slug limit 1`;
  if (!city || !cat) throw new Error("e2e database has no city or category to seed against");
  return { cityId: city.id, verticalId: cat.vertical_id, categoryId: cat.id };
}

/** A published, Verified, free-tier listing — no bid or subscription involved. */
async function verifiedListing(sql: postgres.Sql, s: Seeded, name: string): Promise<string> {
  const id = randomUUID();
  const slug = `e2e-verified-${id.slice(0, 8)}`;
  await sql`insert into listings
    (id, name, slug, city_id, vertical_id, primary_category_id, status, tier, claim_status, source)
    values (${id}, ${name}, ${slug}, ${s.cityId}, ${s.verticalId}, ${s.categoryId},
      'published', 'free', 'verified', 'seed')`;
  // The slug registry is what the public route resolves through — without
  // this row the listing shows in the grid but its own page 404s.
  await sql`insert into slugs (parent_scope, slug, kind, entity_id)
    values (${s.cityId}, ${slug}, 'listing', ${id})
    on conflict do nothing`;
  return id;
}

async function cleanup(sql: postgres.Sql, listingIds: string[]) {
  await sql`delete from slugs where kind = 'listing' and entity_id = any(${listingIds})`;
  await sql`delete from listings where id = any(${listingIds})`;
}

let CITY: string;
let CITY_SLUG: string;
const seededIds: string[] = [];

test.describe("verified-only filter", () => {
  test.skip(REVALIDATE_SECRET === "", "INTERNAL_REVALIDATE_SECRET is not set, so the ISR page cannot be busted");

  test.beforeAll(async ({ request }) => {
    const city = await busiestCity();
    CITY = city.path;
    CITY_SLUG = city.slug;

    const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      const s = await scaffold(sql, CITY_SLUG);
      for (let i = 0; i < PER_PAGE + 1; i++) {
        seededIds.push(await verifiedListing(sql, s, `E2E Verified ${i}`));
      }
    } finally {
      await sql.end({ timeout: 5 });
    }

    const res = await request.post("/api/internal/revalidate", {
      headers: { authorization: `Bearer ${REVALIDATE_SECRET}` },
      data: { paths: [CITY] },
    });
    expect(res.status(), "revalidate must accept the secret").toBe(200);
  });

  test.afterAll(async () => {
    if (seededIds.length === 0) return;
    const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      await cleanup(sql, seededIds);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test("toggles to a filtered grid, keeps the param through pagination, and is noindexed with a canonical to the unfiltered page", async ({
    page,
    request,
  }) => {
    const res = await page.goto(CITY);
    expect(res?.status(), `${CITY} must render`).toBe(200);

    const toggleLink = page.locator('[data-testid="verified-toggle"] a');
    await expect(toggleLink, "toggle must appear once the scope has a verified listing").toBeVisible();
    const onHref = await toggleLink.getAttribute("href");
    expect(onHref).toBe(`${CITY}?verified=1`);

    const filteredRes = await page.goto(onHref!);
    expect(filteredRes?.status(), `${onHref} must render`).toBe(200);

    // Every card on the filtered grid is Verified.
    const cards = page.locator('[data-testid="listing-grid"] > li');
    const cardCount = await cards.count();
    expect(cardCount, "filtered page must render at least one listing").toBeGreaterThan(0);
    const badges = page.locator('[data-testid="listing-grid"] > li [data-testid="verified-badge"]');
    expect(await badges.count()).toBe(cardCount);

    // Pagination exists (PER_PAGE + 1 verified listings force a page 2) and
    // every page link keeps the filter on.
    const pageLinks = page.locator('[data-testid="pagination"] a[href]');
    const linkCount = await pageLinks.count();
    expect(linkCount, "a filtered grid of PER_PAGE + 1 must paginate").toBeGreaterThan(0);
    for (let i = 0; i < linkCount; i++) {
      const href = await pageLinks.nth(i).getAttribute("href");
      expect(href, `pagination link ${i} must carry verified=1`).toContain("verified=1");
    }

    // "2" and "Next" both point at page 2 here (only two pages exist) — take
    // the numbered one specifically.
    const pageTwoHref = await page
      .locator('[data-testid="pagination"] a[aria-label="Page 2"]')
      .getAttribute("href");
    expect(pageTwoHref, "page 2 must exist and carry the filter").toBeTruthy();
    expect(pageTwoHref).toContain("verified=1");

    // Page 2 is a real, server-rendered, still-filtered URL.
    const pageTwoApi = await request.get(pageTwoHref!);
    expect(pageTwoApi.status(), `${pageTwoHref} must return 200`).toBe(200);
    await page.goto(pageTwoHref!);
    const p2Cards = page.locator('[data-testid="listing-grid"] > li');
    const p2Count = await p2Cards.count();
    expect(p2Count, "page 2 of the filtered grid must not be empty").toBeGreaterThan(0);
    const p2Badges = page.locator('[data-testid="listing-grid"] > li [data-testid="verified-badge"]');
    expect(await p2Badges.count()).toBe(p2Count);

    // The filtered view is noindexed, and its canonical points at the
    // unfiltered page — never at itself, and never with a query string.
    await page.goto(onHref!);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const canonical = await page.locator('link[rel="canonical"]').first().getAttribute("href");
    expect(canonical, "filtered pillar page must carry a canonical").toBeTruthy();
    expect(new URL(canonical!).pathname).toBe(CITY);
    expect(canonical).not.toContain("verified");
  });

  test("the toggle switches back to the unfiltered page, which is indexable and carries no verified param", async ({
    page,
  }) => {
    await page.goto(`${CITY}?verified=1`);
    const backLink = page.locator('[data-testid="verified-toggle"] a');
    await expect(backLink).toBeVisible();
    const offHref = await backLink.getAttribute("href");
    expect(offHref).toBe(CITY);

    const res = await page.goto(offHref!);
    expect(res?.status()).toBe(200);
    expect(await page.locator('[data-testid="listing-grid"] > li').count()).toBeGreaterThan(0);
  });
});
