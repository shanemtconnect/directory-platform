import { createClient } from "@redis/client";
import { expect, test } from "@playwright/test";

const CITY = "/richmond-north-yorkshire";

/**
 * The stats pipeline, end to end against a production build.
 *
 * Everything that matters here only behaves like production in a production
 * build: the pillar and listing pages are ISR-cached, which is the entire
 * reason views are counted from the browser rather than in the render.
 */

/**
 * Database 7, never database 0: this worktree's, per the wave plan, and
 * `redis.ts`'s own comment that this server also holds the page cache. A bare
 * fallback with no db index connects to database 0 — the one live traffic's
 * ISR cache runs on — so a developer who forgets to export REDIS_URL before
 * running this suite locally must not end up scanning and asserting against
 * that instead of an isolated test database.
 */
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380/7";

async function redis() {
  const client = createClient({ url: REDIS_URL });
  client.on("error", () => {});
  await client.connect();
  return client;
}

/** Counters for one listing, across every day and metric. */
async function counts(listingId: string): Promise<Record<string, number>> {
  const client = await redis();
  try {
    const out: Record<string, number> = {};
    let cursor = "0";
    do {
      const page = await client.scan(cursor, { MATCH: `stats:${listingId}:*`, COUNT: 500 });
      cursor = String(page.cursor);
      for (const key of page.keys) {
        const metric = key.split(":").at(-1)!;
        out[metric] = (out[metric] ?? 0) + Number(await client.get(key));
      }
    } while (cursor !== "0");
    return out;
  } finally {
    await client.quit();
  }
}

/**
 * The suite drives a real production build against real Redis, so every run
 * leaves counters behind. `flushDb` would be the one-line fix, but this
 * database is not this suite's alone to clear — the vitest specs in
 * `lib/stats/` and `worker/jobs/` share it, possibly concurrently. So this
 * tracks exactly the listing ids this run touched (discovered dynamically, or
 * the fixed one the /api/beacon tests post directly) and on teardown deletes
 * only `stats:<that id>:*` — never a bare `stats:*` scan, which would also
 * catch counters another suite left mid-flight.
 */
const touchedListingIds = new Set<string>();

test.afterAll(async () => {
  if (touchedListingIds.size === 0) return;
  const client = await redis();
  try {
    const keys: string[] = [];
    for (const listingId of touchedListingIds) {
      // The counters, and the day's one-view-per-address mark: it is keyed by a
      // salted digest of the address, so it survives the counter cleanup and
      // would silently drop the next run's view (or an audit's) on this listing.
      let cursor = "0";
      do {
        const page = await client.scan(cursor, {
          MATCH: `stats:${listingId}:*`, COUNT: 500,
        });
        cursor = String(page.cursor);
        keys.push(...page.keys);
      } while (cursor !== "0");
      cursor = "0";
      do {
        const page = await client.scan(cursor, {
          MATCH: `stats:seen:*:*:${listingId}`, COUNT: 500,
        });
        cursor = page.cursor;
        keys.push(...page.keys);
      } while (cursor !== "0");
    }
    if (keys.length > 0) await client.del(keys);
  } finally {
    await client.quit();
  }
});

/**
 * Deletes the day's seen-mark for one listing so this run's view is counted
 * whatever visited the page earlier today from this address — a previous run
 * of this spec, or the Lighthouse audit, both of which leave the mark behind.
 */
async function forgetSeen(listingId: string): Promise<void> {
  const client = await redis();
  try {
    let cursor = "0";
    const keys: string[] = [];
    do {
      const page = await client.scan(cursor, { MATCH: `stats:seen:*:*:${listingId}`, COUNT: 500 });
      cursor = page.cursor;
      keys.push(...page.keys);
    } while (cursor !== "0");
    if (keys.length > 0) await client.del(keys);
  } finally {
    await client.quit();
  }
}

test.describe("the view beacon", () => {
  test("a listing page posts one beacon and the count lands in Redis", async ({ page }) => {
    await page.goto(CITY);
    const firstCard = page.locator('[data-testid="listing-grid"] > li').first();
    const cardId = await firstCard.locator("[data-dp-listing]").first().getAttribute("data-dp-listing");
    if (cardId) await forgetSeen(cardId);
    await firstCard.locator("a").first().click();
    await page.waitForURL(new RegExp(`${CITY}/[a-z0-9-]+$`));

    const marker = page.locator('[data-dp-stat="view"]');
    await expect(marker).toHaveCount(1);
    const listingId = (await marker.getAttribute("data-dp-listing"))!;
    expect(listingId).toMatch(/^[0-9a-f-]{36}$/);
    touchedListingIds.add(listingId);

    // The count is asynchronous by design — sendBeacon does not block the
    // page — so this waits for the number rather than asserting immediately.
    await expect
      .poll(async () => (await counts(listingId)).view ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0);
  });

  test("the inline script is present exactly once and loads nothing", async ({ page }) => {
    await page.goto(CITY);

    // The React flight payload echoes the markup it rendered, so "contains the
    // script" matches twice. Only a script that STARTS with the IIFE is one the
    // browser will execute.
    const scripts = await page.locator("script:not([src])").allTextContents();
    const beacons = scripts.filter((s) => s.trimStart().startsWith("(function(){"));
    expect(beacons).toHaveLength(1);
    expect(beacons[0]).toContain("window.__dpBeacon=1");
    // No third-party analytics on this site, now or by accident later.
    const external = await page.locator("script[src]").evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLScriptElement).src).filter((s) => !s.startsWith(location.origin)));
    expect(external).toEqual([]);
  });

  test("a pillar page counts an impression for every card in one request", async ({ page }) => {
    // Only the count of requests: a `sendBeacon` body is a Blob, which
    // Playwright reports as empty. What the beacon carried is checked against
    // Redis below, which is the thing that matters anyway.
    let posts = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/beacon")) posts += 1;
    });

    await page.goto(CITY);
    const cards = await page.locator('[data-testid="listing-grid"] > li').count();
    expect(cards).toBeGreaterThan(1);

    // A card can appear twice — the featured row repeats one from the grid —
    // so the markers are counted by listing, which is what the script dedupes
    // on before it posts.
    const ids = await page.locator("[data-dp-listing]").evaluateAll((nodes) =>
      [...new Set(nodes.map((n) => n.getAttribute("data-dp-listing")))]);
    expect(ids.length).toBeGreaterThanOrEqual(cards);
    for (const id of ids) touchedListingIds.add(id!);

    // One request for the whole page, not one per card.
    await expect.poll(() => posts, { timeout: 10_000 }).toBe(1);

    // And every card on it was counted by that single request.
    for (const id of ids) {
      await expect
        .poll(async () => (await counts(id!)).impression ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(0);
    }
  });
});

test.describe("the search page", () => {
  test("counts an impression for every result in one request", async ({ page }) => {
    // /search is force-dynamic and its result items are not ListingCards, so
    // it is the one list on the site the card's own marker does not cover.
    let posts = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/beacon")) posts += 1;
    });

    await page.goto("/search");
    const results = page.locator('[data-testid="search-results"] > li');
    const count = await results.count();
    expect(count).toBeGreaterThan(1);

    const ids = await page
      .locator('[data-testid="search-results"] [data-dp-stat="impression"]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-dp-listing")));
    expect(ids).toHaveLength(count);
    for (const id of ids) touchedListingIds.add(id!);

    // Not a view: nobody is looking at one listing on a results page.
    await expect(page.locator('[data-dp-stat="view"]')).toHaveCount(0);

    await expect.poll(() => posts, { timeout: 10_000 }).toBe(1);
    for (const id of ids) {
      await expect
        .poll(async () => (await counts(id!)).impression ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(0);
    }
  });
});

test.describe("/api/beacon", () => {
  const LISTING = "11111111-1111-4111-8111-111111111111";
  touchedListingIds.add(LISTING);
  const BROWSER =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

  test("accepts a well-formed beacon and never caches the answer", async ({ request }) => {
    const res = await request.post("/api/beacon", {
      headers: { "user-agent": BROWSER, "content-type": "application/json" },
      data: { listingId: LISTING, metric: "view" },
    });

    expect(res.status()).toBe(204);
    expect(res.headers()["cache-control"]).toContain("no-store");
  });

  test("ignores a crawler without saying so", async ({ request }) => {
    const res = await request.post("/api/beacon", {
      headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
      data: { listingId: LISTING, metric: "view" },
    });

    expect(res.status()).toBe(204);
  });

  test("refuses a metric a browser may not report", async ({ request }) => {
    // enquiries and shortlist_adds are counted where their rows are written.
    const res = await request.post("/api/beacon", {
      headers: { "user-agent": BROWSER },
      data: { listingId: LISTING, metric: "enquiry" },
    });

    expect(res.status()).toBe(400);
  });

  test("refuses GET", async ({ request }) => {
    const res = await request.get("/api/beacon");
    expect(res.status()).toBe(405);
  });
});
