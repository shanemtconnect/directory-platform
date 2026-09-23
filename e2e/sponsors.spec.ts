import { expect, test } from "@playwright/test";
import { createClient } from "@redis/client";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./database";
import { busiestCity } from "./fixtures";

/**
 * Sponsor rails (Task 43). Run with ADS_ENABLED=true — the template config
 * has the rails off — against a production build (SITE_ENV=production, the
 * suite's default), so the real cards render rather than the staging
 * placeholder:
 *
 *   ADS_ENABLED=true E2E_PORT=3243 REDIS_URL=redis://localhost:6380/11 \
 *     corepack pnpm exec playwright test e2e/sponsors.spec.ts
 *
 * Serial: the campaign is seeded before any ISR page is first rendered.
 */
test.describe.configure({ mode: "serial" });

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380/11";
const RAILS_ON = process.env.ADS_ENABLED === "true";
const TARGET = "https://sponsor-e2e.example/landing?fbclid=abc123&utm_source=directory";

let sql: ReturnType<typeof postgres>;
let campaignId: string;
let userId: string;
let paid: { id: string; tier: string; claimStatus: string; path: string } | null = null;

async function clickCount(id: string): Promise<number> {
  const client = createClient({ url: REDIS_URL });
  client.on("error", () => {});
  await client.connect();
  try {
    let total = 0;
    let cursor = "0";
    do {
      const page = await client.scan(cursor, { MATCH: `sponsor:${id}:*:click`, COUNT: 500 });
      cursor = String(page.cursor);
      for (const key of page.keys) total += Number(await client.get(key));
    } while (cursor !== "0");
    return total;
  } finally {
    await client.quit();
  }
}

test.beforeAll(async () => {
  sql = postgres(E2E_DATABASE_URL, { max: 2, onnotice: () => {} });
  userId = `u_sponsor_e2e_${Date.now()}`;
  await sql`insert into "user" (id, name, email) values (${userId}, 'Sponsor E2E', ${`${userId}@example.com`})`;
  const [profile] = await sql<{ id: string }[]>`insert into profiles (user_id) values (${userId}) returning id`;
  const [row] = await sql<{ id: string }[]>`
    insert into sponsor_campaigns (advertiser_id, name, title, blurb, target_url, status, starts_at, placements)
    values (${profile!.id}, 'Sponsor E2E Ltd', 'Sponsor E2E headline', 'Sponsor E2E blurb.', ${TARGET}, 'active', now(), '{cityPillar,categoryPillar,listingDetail,search,blog}')
    returning id
  `;
  campaignId = row!.id;
});

test.afterAll(async () => {
  if (!sql) return;
  if (paid) {
    await sql`update listings set tier = ${paid.tier}::listing_tier, claim_status = ${paid.claimStatus}::claim_status where id = ${paid.id}`;
  }
  await sql`delete from sponsor_campaigns where id = ${campaignId}`;
  await sql`delete from "user" where id = ${userId}`;
  await sql.end({ timeout: 5 });
});

test("the home page never carries a rail", async ({ request }) => {
  const res = await request.get("/");
  expect(res.ok()).toBe(true);
  expect(await res.text()).not.toContain('data-testid="sponsor-rails"');
});

test("/out 302s to the target with the click id stripped and the click is counted", async ({ request }) => {
  const before = await clickCount(campaignId);
  const res = await request.get(`/out/${campaignId}`, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()["location"]).toBe("https://sponsor-e2e.example/landing?utm_source=directory");
  expect(res.headers()["cache-control"]).toContain("no-store");
  await expect.poll(() => clickCount(campaignId), { timeout: 10_000 }).toBe(before + 1);
});

test("/out 404s an unknown, a malformed and an inactive id", async ({ request }) => {
  expect((await request.get("/out/00000000-0000-4000-8000-000000000000", { maxRedirects: 0 })).status()).toBe(404);
  expect((await request.get("/out/not-a-uuid", { maxRedirects: 0 })).status()).toBe(404);
  await sql`update sponsor_campaigns set status = 'paused' where id = ${campaignId}`;
  expect((await request.get(`/out/${campaignId}`, { maxRedirects: 0 })).status()).toBe(404);
  await sql`update sponsor_campaigns set status = 'active' where id = ${campaignId}`;
});

test.describe("rails on (ADS_ENABLED=true)", () => {
  test.skip(!RAILS_ON, "run with ADS_ENABLED=true");

  test("a paid listing page has no rail", async ({ request }) => {
    const [row] = await sql<{ id: string; tier: string; claim_status: string; city: string; slug: string }[]>`
      select l.id, l.tier, l.claim_status, c.slug as city, l.slug
      from listings l join cities c on c.id = l.city_id
      where l.status = 'published' and c.is_published
      order by l.created_at desc, l.slug limit 1
    `;
    expect(row).toBeTruthy();
    paid = { id: row!.id, tier: row!.tier, claimStatus: row!.claim_status, path: `/${row!.city}/${row!.slug}` };
    await sql`update listings set tier = 'premium', claim_status = 'verified' where id = ${paid.id}`;
    const res = await request.get(paid.path);
    expect(res.ok()).toBe(true);
    expect(await res.text()).not.toContain('data-testid="sponsor-rails"');
  });

  test("an unpaid listing page carries live rails with house ads and the sponsor card", async ({ request }) => {
    const [row] = await sql<{ city: string; slug: string }[]>`
      select c.slug as city, l.slug
      from listings l join cities c on c.id = l.city_id
      where l.status = 'published' and c.is_published
        and l.tier = 'free' and l.claim_status <> 'verified'
      order by l.created_at asc, l.slug limit 1
    `;
    expect(row, "the e2e database has an unpaid published listing").toBeTruthy();
    const res = await request.get(`/${row!.city}/${row!.slug}`);
    expect(res.ok()).toBe(true);
    const html = await res.text();
    expect(html).toContain('data-testid="sponsor-rails"');
    expect(html).toContain('data-state="live"');
    expect(html).toContain('data-kind="house"');
    expect(html).toContain(`data-campaign="${campaignId}"`);
    expect(html).toContain(`href="/out/${campaignId}"`);
    expect(html).toContain('rel="sponsored nofollow"');
    expect(html).toContain(`data-dp-stat="sponsor_impression" data-dp-listing="${campaignId}"`);
    // no ad network, no third-party script
    expect(html).not.toMatch(/<script[^>]+src="https?:\/\/(?!localhost)/);
  });

  test("a city pillar page carries the rails too; the script is still inlined once", async ({ page }) => {
    const city = await busiestCity();
    await page.goto(city.path);
    await expect(page.locator('[data-testid="sponsor-rail-left"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="sponsor-rail-right"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="sponsor-inline"]')).toHaveCount(1);
    // Sponsor cards and listing cards share one beacon script (see e2e/stats.spec.ts
    // for why the flight payload makes a plain text count read double).
    const scripts = await page.locator("script:not([src])").allTextContents();
    expect(scripts.filter((s) => s.trimStart().startsWith("(function(){"))).toHaveLength(1);
  });
});
