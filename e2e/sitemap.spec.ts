import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * /sitemap.xml is now an INDEX of shards, not a flat list of URLs.
 *
 * A directory outgrows one file, so listings are sharded and cities,
 * categories and the static pages each get their own. These tests read the
 * index, then read every shard it names, and assert on the union — which is
 * also the check that the index and the shards agree.
 */
async function xmlTags(page: Page, source: string, tag: string): Promise<string[]> {
  return page.evaluate(
    ([src, name]: [string, string]) => {
      const doc = new DOMParser().parseFromString(src, "application/xml");
      return Array.from(doc.getElementsByTagName(name)).map((n) => n.textContent ?? "");
    },
    [source, tag] as [string, string],
  );
}

async function parseError(page: Page, source: string): Promise<string | null> {
  return page.evaluate((src: string) => {
    const doc = new DOMParser().parseFromString(src, "application/xml");
    const err = doc.querySelector("parsererror");
    return err ? err.textContent : null;
  }, source);
}

async function allLocs(page: Page, request: APIRequestContext): Promise<string[]> {
  const index = await (await request.get("/sitemap.xml")).text();
  const shards = await xmlTags(page, index, "loc");
  const locs: string[] = [];
  for (const shard of shards) {
    const res = await request.get(new URL(shard).pathname);
    expect(res.status(), `${shard} is in the index but returns ${res.status()}`).toBe(200);
    locs.push(...(await xmlTags(page, await res.text(), "loc")));
  }
  return locs;
}

test.describe("sitemap.xml", () => {
  test("is a well-formed index whose shards are all absolute and all resolve", async ({ page, request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status(), "/sitemap.xml must return 200").toBe(200);
    expect(res.headers()["content-type"] ?? "").toMatch(/xml/i);

    const xml = await res.text();
    await page.goto("about:blank");
    expect(await parseError(page, xml), "sitemap.xml is not well-formed XML").toBeNull();

    const shards = await xmlTags(page, xml, "loc");
    expect(shards.length, "the index must name at least one shard").toBeGreaterThan(0);
    // The two fixed shards plus at least one listing shard.
    expect(shards.some((s) => s.includes("static"))).toBe(true);
    expect(shards.some((s) => s.includes("categories"))).toBe(true);
    expect(shards.some((s) => s.includes("listings-0"))).toBe(true);

    for (const shard of shards) {
      expect(shard, `shard <loc> is not absolute: ${shard}`).toMatch(/^https?:\/\/[^/\s]+\//);
      const shardRes = await request.get(new URL(shard).pathname);
      expect(shardRes.status(), `${shard} returns ${shardRes.status()}`).toBe(200);
      expect(await parseError(page, await shardRes.text()), `${shard} is not well-formed`).toBeNull();
    }
  });

  test("every URL across every shard is absolute, http(s), and unique", async ({ page, request }) => {
    await page.goto("about:blank");
    const locs = await allLocs(page, request);

    expect(locs.length, "the sitemap must list URLs").toBeGreaterThan(0);

    for (const loc of locs) {
      expect(loc.trim(), "empty <loc>").not.toBe("");
      // Absolute, with a scheme and a host. A relative <loc> is invalid and is
      // silently dropped by Search Console. (The homepage entry is the bare
      // origin with no trailing slash, which is a legitimate absolute URL.)
      expect(loc, `<loc> is not absolute: ${loc}`).toMatch(/^https?:\/\/[^/\s]+(\/|$)/);
      expect(() => new URL(loc), `<loc> is not a parseable URL: ${loc}`).not.toThrow();
      expect(new URL(loc).protocol, `<loc> has a non-http scheme: ${loc}`).toMatch(/^https?:$/);
      expect(new URL(loc).host, `<loc> has no host: ${loc}`).not.toBe("");
    }

    // No duplicates: the same URL twice is a self-inflicted crawl-budget tax.
    // Across shards too — a paging bug that repeats a listing shows up here.
    expect(new Set(locs).size, "sitemap contains duplicate <loc> entries").toBe(locs.length);
  });

  test("listed URLs actually resolve", async ({ page, request }) => {
    await page.goto("about:blank");
    const locs = await allLocs(page, request);

    // Sample rather than crawl every entry — this is a smoke test.
    const indices = [0, Math.floor(locs.length / 2), locs.length - 1];
    const sample = indices
      .map((i) => locs[i])
      .filter((loc): loc is string => typeof loc === "string" && loc !== "");
    expect(sample.length).toBeGreaterThan(0);
    for (const loc of sample) {
      const r = await request.get(new URL(loc).pathname);
      expect(r.status(), `${loc} is in the sitemap but returns ${r.status()}`).toBe(200);
    }
  });

  test("search is excluded from the sitemap", async ({ page, request }) => {
    await page.goto("about:blank");
    const locs = await allLocs(page, request);
    for (const loc of locs) {
      expect(new URL(loc).pathname, "noindexed search URLs must never be advertised")
        .not.toMatch(/^\/search/);
    }
  });

  test("robots.txt points at the index", async ({ request }) => {
    const robots = await (await request.get("/robots.txt")).text();
    expect(robots).toMatch(/Sitemap:\s*https?:\/\/\S+\/sitemap\.xml/i);
  });
});
