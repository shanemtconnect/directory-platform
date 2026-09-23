import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./database";
import { busiestCity, quietCity } from "./fixtures";

/**
 * Featured spots, end to end, with no PayPal involved.
 *
 * There are no PayPal credentials here — deliberately — so a bid cannot be
 * approved and confirmed through the real provider. What IS proved:
 *
 *  - the owner's bidding page: gated to the owner, lists this town's spots
 *    with the floor as the entry price, shows the monthly total, and refuses
 *    to take a bid while featured spots are not set up;
 *  - the public row: confirmed bids render above the organic grid in rank
 *    order, labelled Featured, excluded from the grid below — and a change
 *    in the ranking reaches the ISR page through the same revalidation the
 *    actions and the worker use.
 *
 * The ranking rows for the second half are written straight into the
 * database in the state the engine leaves them in (the engine's transitions
 * are proved in lib/spots/bidding.test.ts against a fake PayPal). The ISR
 * page is busted through /api/internal/revalidate, which needs
 * INTERNAL_REVALIDATE_SECRET set for the server AND this process; without it
 * that test is skipped rather than failed.
 */

const DATABASE_URL = E2E_DATABASE_URL;
const REVALIDATE_SECRET = process.env.INTERNAL_REVALIDATE_SECRET?.trim() ?? "";

async function signUp(page: Page): Promise<string> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-featured+${stamp}@example.com`;
  await page.goto("/signup");
  const form = page.locator('[data-testid="signup-form"]');
  await expect(form).toBeVisible();
  await form.locator("#name").fill("Playwright Featured");
  await form.locator("#email").fill(email);
  await form.locator("#password").fill(`pw-${stamp}-longenough`);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/account$/, { timeout: 30_000 });
  return email;
}

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

/** A published, Verified listing on an active paid plan: one that may bid. */
async function verifiedListing(sql: postgres.Sql, s: Seeded, profileId: string | null, name: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into listings
    (id, name, slug, city_id, vertical_id, primary_category_id, status, tier, claim_status, owner_id, source)
    values (${id}, ${name}, ${`e2e-featured-${id.slice(0, 8)}`}, ${s.cityId}, ${s.verticalId}, ${s.categoryId},
      'published', 'premium', 'verified', ${profileId}, 'seed')`;
  await sql`insert into subscriptions (listing_id, user_id, tier, interval, status, provider_plan_id)
    values (${id}, ${profileId}, 'premium', 'monthly', 'active', 'P-E2E')`;
  return id;
}

async function cleanup(sql: postgres.Sql, listingIds: string[], spotId: string | null) {
  await sql`delete from featured_bids where listing_id = any(${listingIds})`;
  await sql`delete from featured_subscriptions where listing_id = any(${listingIds})`;
  if (spotId !== null) await sql`delete from featured_spots where id = ${spotId}`;
  await sql`delete from listings where id = any(${listingIds})`;
}

test.describe("the owner's bidding page", () => {
  test("lists this town's spots at the floor, shows the total, and refuses bids while not set up", async ({ page }) => {
    const city = await quietCity();
    const email = await signUp(page);
    const sql = postgres(DATABASE_URL, { max: 1 });
    let listingId: string | null = null;
    try {
      const [u] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
      await sql`insert into profiles (user_id) values (${u!.id}) on conflict (user_id) do nothing`;
      const [p] = await sql<{ id: string }[]>`select id from profiles where user_id = ${u!.id}`;
      const s = await scaffold(sql, city.slug);
      listingId = await verifiedListing(sql, s, p!.id, "Playwright Bidder");

      await page.goto(`/account/listings/${listingId}/featured`);
      await expect(page.locator('[data-testid="featured-page"]')).toBeVisible();
      await expect(page.locator('[data-testid="spots-unavailable"]')).toBeVisible();
      await expect(page.locator('[data-testid="monthly-total"]')).toContainText("0");

      // The town's own spot first, nobody on it, priced at the floor both to
      // enter and to lead.
      const rows = page.locator('[data-testid="spot-table-here"] [data-testid="spot-row"]');
      expect(await rows.count()).toBeGreaterThanOrEqual(2);
      const first = rows.first();
      await expect(first).toHaveAttribute("data-spot", `city:${s.cityId}:-`);
      await expect(first.locator('[data-testid="spot-top"]')).toContainText("nobody yet");
      await expect(first.locator('[data-testid="spot-top"]')).toContainText("0 of 3");
      await expect(first.locator('[data-testid="spot-minimums"]')).toContainText("50");
      await expect(first.locator('[data-testid="bid-amount"]')).toHaveValue("50");
      await expect(first.locator('[data-testid="bid-submit"]')).toBeDisabled();

      // The category spot sits under it.
      await expect(rows.nth(1)).toHaveAttribute("data-spot", `city:${s.cityId}:${s.categoryId}`);

      // The page is not indexed and is the owner's alone.
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      const stranger = await verifiedListing(sql, s, null, "Somebody Else");
      try {
        const res = await page.goto(`/account/listings/${stranger}/featured`);
        expect(res?.status()).toBe(404);
      } finally {
        await cleanup(sql, [stranger], null);
      }
    } finally {
      if (listingId !== null) await cleanup(sql, [listingId], null);
      await sql.end({ timeout: 5 });
    }
  });
});

test.describe("the featured row on the city page", () => {
  test.skip(REVALIDATE_SECRET === "", "INTERNAL_REVALIDATE_SECRET is not set, so the ISR page cannot be busted");

  test("shows the confirmed bids in rank order, out of the grid, and follows a re-rank after revalidation", async ({ page, request }) => {
    const city = await quietCity();
    const sql = postgres(DATABASE_URL, { max: 1 });
    const ids: string[] = [];
    let spotId: string | null = null;
    try {
      const s = await scaffold(sql, city.slug);
      const alpha = await verifiedListing(sql, s, null, "Playwright Alpha Featured");
      const bravo = await verifiedListing(sql, s, null, "Playwright Bravo Featured");
      ids.push(alpha, bravo);

      // The rows the engine leaves behind after two confirmed bids.
      const [spot] = await sql<{ id: string }[]>`
        insert into featured_spots (area_kind, area_id, category_id, positions, floor_cents, status)
        values ('city', ${s.cityId}, null, 3, 5000, 'open')
        on conflict do nothing returning id`;
      const [existing] = await sql<{ id: string }[]>`
        select id from featured_spots where area_kind = 'city' and area_id = ${s.cityId} and category_id is null`;
      spotId = spot?.id ?? existing!.id;
      const subs: Record<string, string> = {};
      for (const [listingId, n] of [[alpha, 1], [bravo, 2]] as const) {
        const [sub] = await sql<{ id: string }[]>`
          insert into featured_subscriptions (listing_id, provider_subscription_id, provider_plan_id, status, quantity, requested_quantity)
          values (${listingId}, ${`I-E2E-${listingId.slice(0, 8)}-${n}`}, 'P-F-E2E', 'active', 60, 60) returning id`;
        subs[listingId] = sub!.id;
      }
      await sql`insert into featured_bids (spot_id, listing_id, subscription_id, amount_cents, status, position)
        values (${spotId}, ${alpha}, ${subs[alpha]!}, 6000, 'active', 1),
               (${spotId}, ${bravo}, ${subs[bravo]!}, 5000, 'active', 2)`;

      const revalidate = async () => {
        const res = await request.post("/api/internal/revalidate", {
          headers: { authorization: `Bearer ${REVALIDATE_SECRET}` },
          data: { paths: [city.path] },
        });
        expect(res.status(), "revalidate must accept the secret").toBe(200);
      };
      await revalidate();

      await page.goto(city.path);
      const row = page.locator('[data-testid="featured-row"]');
      await expect(row).toBeVisible();
      const names = row.locator("li > a");
      await expect(names).toHaveText(["Playwright Alpha Featured", "Playwright Bravo Featured"]);
      await expect(row.locator('[data-testid="featured-label"]')).toHaveCount(2);
      await expect(row.locator("li").first()).toHaveAttribute("data-position", "1");

      // Not listed twice.
      const grid = page.locator('[data-testid="listing-grid"]');
      await expect(grid.locator("li > a", { hasText: "Playwright Alpha Featured" })).toHaveCount(0);
      await expect(grid.locator("li > a", { hasText: "Playwright Bravo Featured" })).toHaveCount(0);

      // Bravo raises above Alpha: the engine's re-rank, as rows.
      await sql`update featured_bids set amount_cents = 7000, position = 1 where listing_id = ${bravo}`;
      await sql`update featured_bids set position = 2 where listing_id = ${alpha}`;
      await revalidate();

      await page.goto(city.path);
      await expect(page.locator('[data-testid="featured-row"] li > a')).toHaveText([
        "Playwright Bravo Featured",
        "Playwright Alpha Featured",
      ]);
    } finally {
      await cleanup(sql, ids, spotId);
      await sql.end({ timeout: 5 });
    }
  });
});

/* ------------------------------------------------------------- Task 45 */

/** A spot row for the quiet city (or the one already there). */
async function citySpot(sql: postgres.Sql, cityId: string): Promise<string> {
  const [spot] = await sql<{ id: string }[]>`
    insert into featured_spots (area_kind, area_id, category_id, positions, floor_cents, status)
    values ('city', ${cityId}, null, 3, 5000, 'open')
    on conflict do nothing returning id`;
  if (spot) return spot.id;
  const [existing] = await sql<{ id: string }[]>`
    select id from featured_spots where area_kind = 'city' and area_id = ${cityId} and category_id is null`;
  return existing!.id;
}

async function confirmedBid(
  sql: postgres.Sql,
  spotId: string,
  listingId: string,
  amountCents: number,
  position: number | null,
  n: number,
): Promise<string> {
  const [sub] = await sql<{ id: string }[]>`
    insert into featured_subscriptions (listing_id, provider_subscription_id, provider_plan_id, status, quantity, requested_quantity)
    values (${listingId}, ${`I-E2E45-${listingId.slice(0, 8)}-${n}`}, 'P-F-E2E', 'active', ${amountCents / 100}, ${amountCents / 100})
    returning id`;
  const [bid] = await sql<{ id: string }[]>`
    insert into featured_bids (spot_id, listing_id, subscription_id, amount_cents, status, position)
    values (${spotId}, ${listingId}, ${sub!.id}, ${amountCents}, 'active', ${position}) returning id`;
  return bid!.id;
}

test.describe("leaderboard, outbid email and the owner's tools (Task 45)", () => {
  test("the leaderboard shows the three positions; a re-rank queues the outbid emails with the amount to retake", async ({ page }) => {
    // The busiest town, not the quiet one: the owner-page spec above asserts
    // the quiet town's spot is empty, and this one fills a spot with bids.
    const city = await busiestCity();
    const email = await signUp(page);
    const sql = postgres(DATABASE_URL, { max: 1 });
    const ids: string[] = [];
    let spotId: string | null = null;
    try {
      const [u] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
      await sql`insert into profiles (user_id) values (${u!.id}) on conflict (user_id) do nothing`;
      const [p] = await sql<{ id: string }[]>`select id from profiles where user_id = ${u!.id}`;
      const s = await scaffold(sql, city.slug);
      spotId = await citySpot(sql, s.cityId);

      // The rows the engine leaves after three confirmed bids, plus a fourth
      // (Delta, 85) confirmed by PayPal a moment ago and not yet re-ranked,
      // and the signed-in owner's own outbid bid (Echo, 40).
      const alpha = await verifiedListing(sql, s, null, "Playwright Alpha Board");
      const bravo = await verifiedListing(sql, s, null, "Playwright Bravo Board");
      const charlie = await verifiedListing(sql, s, null, "Playwright Charlie Board");
      const delta = await verifiedListing(sql, s, null, "Playwright Delta Board");
      const echo = await verifiedListing(sql, s, p!.id, "Playwright Echo Board");
      ids.push(alpha, bravo, charlie, delta, echo);
      const alphaBid = await confirmedBid(sql, spotId, alpha, 8000, 1, 1);
      await confirmedBid(sql, spotId, bravo, 7000, 2, 2);
      const charlieBid = await confirmedBid(sql, spotId, charlie, 6000, 3, 3);
      await confirmedBid(sql, spotId, delta, 8500, null, 4);
      await confirmedBid(sql, spotId, echo, 4000, null, 5);

      // The public leaderboard: names in order, "3 of 3 taken", no amounts, noindex.
      await page.goto(`/spots/${spotId}`);
      const board = page.locator('[data-testid="spot-leaderboard"]');
      await expect(board).toBeVisible();
      await expect(page.locator('[data-testid="spot-scarcity"]')).toContainText("3 of 3 taken");
      await expect(page.locator('[data-testid="spot-positions"] li a')).toHaveText([
        "Playwright Alpha Board", "Playwright Bravo Board", "Playwright Charlie Board",
      ]);
      expect(await board.textContent()).not.toMatch(/[£$€]\s?\d/);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

      // The owner's page links the leaderboard and honours the email's prefill.
      await page.goto(`/account/listings/${echo}/featured?bid=city:${s.cityId}:-&amount=71`);
      await expect(page.locator('[data-testid="prefill-notice"]')).toBeVisible();
      const row = page.locator(`[data-testid="spot-row"][data-spot="city:${s.cityId}:-"]`);
      await expect(row.locator('[data-testid="bid-amount"]')).toHaveValue("71");
      await expect(row.locator('[data-testid="spot-leaderboard"]')).toHaveAttribute("href", `/spots/${spotId}`);
      await expect(row.locator('[data-testid="spot-you"]')).toContainText("outbid");
      await expect(page.locator('[data-testid="bid-history"]')).toBeVisible();

      // Echo cancels: the spot is settled — Delta takes first, Charlie drops
      // out — and two outbid jobs land in the queue with the amounts to retake.
      await row.locator('[data-testid="cancel-bid"]').click();
      await row.locator('[data-testid="cancel-bid-confirm"]').click();
      // The action revalidates this page, so the row re-renders without a
      // bid; the history is where the cancellation is now visible.
      await expect(page.locator('[data-testid="bid-history"]')).toContainText("Bid cancelled", { timeout: 15_000 });
      await expect(row.locator('[data-testid="spot-you"]')).toHaveText("—");

      const jobs = await sql<{ payload: { bidId: string; kind: string; amountCents: number } }[]>`
        select payload from job_queue where kind = 'notify.spot.outbid' and payload->>'bidId' = any(${[alphaBid, charlieBid]})`;
      expect(jobs.map((j) => j.payload).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
        // Charlie: the lowest featured is Bravo's 70, so 71 gets back in.
        { bidId: charlieBid, kind: "dropped-out", amountCents: 7100 },
        // Alpha: Delta's 85 + max(10%, 5) = 93.5 → 94.
        { bidId: alphaBid, kind: "lost-first", amountCents: 9400 },
      ]);

      await page.goto(`/spots/${spotId}`);
      await expect(page.locator('[data-testid="spot-positions"] li a')).toHaveText([
        "Playwright Delta Board", "Playwright Alpha Board", "Playwright Bravo Board",
      ]);
    } finally {
      await sql`delete from job_queue where kind = 'notify.spot.outbid' and payload->>'bidId' in
        (select id::text from featured_bids where listing_id = any(${ids}))`;
      await cleanup(sql, ids, spotId);
      await sql.end({ timeout: 5 });
    }
  });

  test("a signed-in owner whose listing is on the town page but not featured sees the upsell strip; a stranger does not", async ({ page, browser }) => {
    const city = await quietCity();
    const email = await signUp(page);
    const sql = postgres(DATABASE_URL, { max: 1 });
    let listingId: string | null = null;
    try {
      const [u] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
      await sql`insert into profiles (user_id) values (${u!.id}) on conflict (user_id) do nothing`;
      const [p] = await sql<{ id: string }[]>`select id from profiles where user_id = ${u!.id}`;
      const s = await scaffold(sql, city.slug);
      listingId = await verifiedListing(sql, s, p!.id, "Playwright Upsell Owner");

      await page.goto(city.path);
      const strip = page.locator('[data-testid="featured-upsell"]');
      await expect(strip).toBeVisible({ timeout: 15_000 });
      await expect(strip).toContainText("Playwright Upsell Owner");
      await expect(strip).toContainText("/month");
      await expect(strip.locator('[data-testid="featured-upsell-link"]')).toHaveAttribute("href", `/account/listings/${listingId}/featured`);

      // Anonymous: the same cached page, no strip, and the fetch answers 204.
      const anon = await browser.newContext();
      const anonPage = await anon.newPage();
      const res = await anonPage.request.get(`/api/spots/upsell?key=city:${s.cityId}:-`);
      expect(res.status()).toBe(204);
      await anonPage.goto(city.path);
      await anonPage.waitForTimeout(1500);
      await expect(anonPage.locator('[data-testid="featured-upsell"]')).toHaveCount(0);
      await anon.close();
    } finally {
      if (listingId !== null) await cleanup(sql, [listingId], null);
      await sql.end({ timeout: 5 });
    }
  });
});

test.describe("the featured row on the region page (Task 45)", () => {
  test.skip(REVALIDATE_SECRET === "", "INTERNAL_REVALIDATE_SECRET is not set, so the ISR page cannot be busted");

  test("shows the region spot's confirmed bids above the region's list, out of the grid", async ({ page, request }) => {
    const city = await quietCity();
    if (city.region === null) throw new Error("the quiet city has no region");
    const regionSlug = city.region.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const sql = postgres(DATABASE_URL, { max: 1 });
    const ids: string[] = [];
    let spotId: string | null = null;
    try {
      const s = await scaffold(sql, city.slug);
      const alpha = await verifiedListing(sql, s, null, "Playwright Alpha Region");
      ids.push(alpha);
      const [spot] = await sql<{ id: string }[]>`
        insert into featured_spots (area_kind, area_id, category_id, positions, floor_cents, status)
        values ('region', ${regionSlug}, null, 3, 10000, 'open')
        on conflict do nothing returning id`;
      const [existing] = await sql<{ id: string }[]>`
        select id from featured_spots where area_kind = 'region' and area_id = ${regionSlug} and category_id is null`;
      spotId = spot?.id ?? existing!.id;
      await confirmedBid(sql, spotId, alpha, 12000, 1, 9);

      const res = await request.post("/api/internal/revalidate", {
        headers: { authorization: `Bearer ${REVALIDATE_SECRET}` },
        data: { paths: [`/areas/${regionSlug}`] },
      });
      expect(res.status()).toBe(200);

      await page.goto(`/areas/${regionSlug}`);
      const row = page.locator('[data-testid="featured-row"]');
      await expect(row).toBeVisible();
      await expect(row.locator("li > a")).toHaveText(["Playwright Alpha Region"]);
      await expect(row.locator("ul")).toHaveAttribute("data-dp-spot", spotId);
      await expect(row.locator('[data-testid="featured-how"]')).toHaveAttribute("href", `/spots/${spotId}`);
      await expect(page.locator('[data-testid="listing-grid"] li > a', { hasText: "Playwright Alpha Region" })).toHaveCount(0);
    } finally {
      await cleanup(sql, ids, spotId);
      await sql.end({ timeout: 5 });
    }
  });
});
