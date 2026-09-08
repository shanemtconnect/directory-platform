import { expect, test } from "@playwright/test";

test.describe("sitemap.xml", () => {
  test("is served, is well-formed XML, and every <loc> is absolute", async ({ page, request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status(), "/sitemap.xml must return 200").toBe(200);
    expect(res.headers()["content-type"] ?? "").toMatch(/xml/i);

    const xml = await res.text();
    expect(xml.length, "sitemap must not be empty").toBeGreaterThan(0);

    // Well-formedness checked by a real XML parser, not a regex.
    await page.goto("about:blank");
    const parseError = await page.evaluate((source: string) => {
      const doc = new DOMParser().parseFromString(source, "application/xml");
      const err = doc.querySelector("parsererror");
      return err ? err.textContent : null;
    }, xml);
    expect(parseError, "sitemap.xml is not well-formed XML").toBeNull();

    const locs = await page.evaluate((source: string) => {
      const doc = new DOMParser().parseFromString(source, "application/xml");
      return Array.from(doc.getElementsByTagName("loc")).map((n) => n.textContent ?? "");
    }, xml);

    expect(locs.length, "sitemap must list URLs").toBeGreaterThan(0);

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
    expect(new Set(locs).size, "sitemap contains duplicate <loc> entries").toBe(locs.length);
  });

  test("listed URLs actually resolve", async ({ page, request }) => {
    const res = await request.get("/sitemap.xml");
    const xml = await res.text();

    await page.goto("about:blank");
    const locs: string[] = await page.evaluate((source: string) => {
      const doc = new DOMParser().parseFromString(source, "application/xml");
      return Array.from(doc.getElementsByTagName("loc")).map((n) => n.textContent ?? "");
    }, xml);

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

  test("search is excluded from the sitemap", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    expect(xml, "noindexed search URLs must never be advertised").not.toMatch(/<loc>[^<]*\/search[^<]*<\/loc>/);
  });
});
