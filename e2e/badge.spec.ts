import { expect, test } from "@playwright/test";

/**
 * The badge is the one thing this site serves to OTHER people's websites, so
 * the contract it has to keep is unusually strict: an image that renders
 * cross-origin, a click that lands on the listing, and neither of them able to
 * leak an unpublished row.
 *
 * Everything here runs against the seeded dev database through a production
 * build, so the ids come out of the sitemap rather than being hardcoded.
 */

/** A published listing's canonical path and id, taken from the live site. */
async function aPublishedListing(
  request: import("@playwright/test").APIRequestContext,
): Promise<{ path: string; id: string }> {
  // Via the index, not a guessed shard path: the shard URL shape belongs to
  // Next's generateSitemaps and has changed once already.
  const sitemapIndex = await request.get("/sitemap.xml");
  expect(sitemapIndex.ok()).toBe(true);
  const shard = /<loc>([^<]*listings-0[^<]*)<\/loc>/.exec(await sitemapIndex.text());
  expect(shard, "the sitemap index names a listings-0 shard").not.toBeNull();
  const index = await request.get(new URL(shard![1]!).pathname);
  expect(index.ok()).toBe(true);
  const xml = await index.text();
  const loc = /<loc>([^<]+)<\/loc>/.exec(xml);
  expect(loc, "the listings sitemap has at least one URL").not.toBeNull();
  const path = new URL(loc![1]!).pathname;

  // The badge page resolves its own id from ?id=, so the id has to come from
  // the page that hands owners their snippet.
  const page = await request.get(path);
  expect(page.ok()).toBe(true);
  const html = await page.text();
  const id = /\/badge\/([0-9a-f-]{36})/.exec(html)?.[1] ?? null;
  // A FAILURE, not a skip. A listing page that stopped rendering a badge URL
  // is the badge feature being broken — which is precisely what this spec
  // exists to catch, and a skipped test reports it as a green run.
  expect(id, `${path} renders a /badge/{id} URL`).not.toBeNull();
  return { path, id: id! };
}

test.describe("badge", () => {
  test("serves an SVG that a third-party site can embed", async ({ request }) => {
    const { path } = await aPublishedListing(request);
    const badgePage = await request.get(`/advertise/badge`);
    expect(badgePage.ok()).toBe(true);

    const html = await badgePage.text();
    const id = /\/badge\/([0-9a-f-]{36})/.exec(html)?.[1];
    expect(id, "the badge page offers a snippet pointing at /badge/{id}").toBeTruthy();

    const svg = await request.get(`/badge/${id}`);
    expect(svg.status()).toBe(200);
    expect(svg.headers()["content-type"]).toContain("image/svg+xml");
    // Embedded cross-origin by design; without this the image is blocked.
    expect(svg.headers()["access-control-allow-origin"]).toBe("*");
    expect(svg.headers()["x-content-type-options"]).toBe("nosniff");
    expect(await svg.text()).toContain("<svg");
    expect(path).toMatch(/^\//);
  });

  test("404s a badge for an id that is not a published listing", async ({ request }) => {
    const nobody = await request.get("/badge/00000000-0000-4000-8000-000000000000");
    expect(nobody.status()).toBe(404);
    const rubbish = await request.get("/badge/not-a-uuid");
    expect(rubbish.status()).toBe(404);
  });

  test("the click endpoint 302s to the listing with its utm tags", async ({ request }) => {
    const { id } = await aPublishedListing(request);

    const res = await request.get(`/api/badge-click?id=${id}`, { maxRedirects: 0 });

    expect(res.status()).toBe(302);
    const location = res.headers()["location"] ?? "";
    expect(location).toContain("utm_source=badge");
    // A 301 would be cached by the browser and the second click would never
    // reach us, so the counter would stop at one per visitor for ever.
    expect(res.status()).not.toBe(301);
    expect(res.headers()["cache-control"]).toContain("no-store");
  });

  test("the click endpoint refuses a malformed or unknown id", async ({ request }) => {
    const bad = await request.get("/api/badge-click?id=not-a-uuid", { maxRedirects: 0 });
    expect(bad.status()).toBe(400);
    const missing = await request.get("/api/badge-click", { maxRedirects: 0 });
    expect(missing.status()).toBe(400);
    const unknown = await request.get(
      "/api/badge-click?id=00000000-0000-4000-8000-000000000000",
      { maxRedirects: 0 },
    );
    expect(unknown.status()).toBe(404);
  });

  test("an outreach magic link that nobody was sent is a plain 404", async ({ request }) => {
    const res = await request.get("/claim/outreach/not-a-real-token", { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    // Never cached, never leaked through a referer: the token is a credential.
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  });
});
