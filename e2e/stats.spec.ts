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

async function redis() {
  const client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6380" });
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

test.describe("the view beacon", () => {
  test("a listing page posts one beacon and the count lands in Redis", async ({ page }) => {
    await page.goto(CITY);
    await page.locator('[data-testid="listing-grid"] > li a').first().click();
    await page.waitForURL(new RegExp(`${CITY}/[a-z0-9-]+$`));

    const marker = page.locator('[data-dp-stat="view"]');
    await expect(marker).toHaveCount(1);
    const listingId = (await marker.getAttribute("data-dp-listing"))!;
    expect(listingId).toMatch(/^[0-9a-f-]{36}$/);

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

test.describe("/api/beacon", () => {
  const LISTING = "11111111-1111-4111-8111-111111111111";
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
