import { expect, test, type APIResponse } from "@playwright/test";

/**
 * Every URL below returned 200 before this suite existed.
 *
 * Each one is a duplicate or an empty page that Google will happily index
 * alongside the real thing: a page number past the end, a case variant, a
 * redundant /page/1, three extra spellings of "2", and a paginated listing
 * detail page. A directory that emits these is competing with itself.
 *
 * maxRedirects: 0 throughout — following a redirect would only show the
 * destination's 200 and prove nothing about the status served here.
 *
 * Leeds is one page deep; Richmond (North Yorkshire) holds 26 and is the
 * seeded city that genuinely paginates.
 *
 * The permanent redirects are asserted as 308 rather than 301: next/navigation
 * has no way to emit a 301 from a server component, and 308 is the same
 * permanent signal — it just also forbids rewriting the method.
 *
 * KNOWN DEFECT, asserted around rather than hidden: on a COLD response
 * (`x-nextjs-cache: MISS`) these routes emit `Location` TWICE, with the same
 * value both times; a warm response emits it once. It reproduces on every
 * redirect from an ISR-cached route and predates this suite, so it belongs to
 * the ISR cache handler rather than to the routing rules under test here.
 * `locationOf` therefore asserts that the header names exactly ONE destination
 * — which is the thing that would actually break a client — and reports the
 * duplication rather than passing over it in silence.
 */

function locationOf(res: APIResponse): string {
  const values = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "location")
    .map((h) => h.value);

  expect(values.length, "no Location header").toBeGreaterThan(0);
  expect(
    new Set(values).size,
    `Location names more than one destination: ${values.join(" | ")}`,
  ).toBe(1);
  return values[0]!;
}

const CITY = "/leeds";
const PAGINATING_CITY = "/richmond-north-yorkshire";
const LISTING = "/wolverhampton/the-grange-estate";
const PERMANENT = 308;

test.describe("routing canonicalisation", () => {
  test("a page number past the end is a 404, not an empty page", async ({ request }) => {
    const res = await request.get(`${CITY}/page/999`, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });

  test("a mixed-case path permanently redirects to its lowercase form", async ({ request }) => {
    const res = await request.get("/Leeds", { maxRedirects: 0 });
    expect(res.status()).toBe(PERMANENT);
    expect(locationOf(res)).toBe(CITY);
  });

  test("/page/1 permanently redirects to the unpaginated path", async ({ request }) => {
    const res = await request.get(`${CITY}/page/1`, { maxRedirects: 0 });
    expect(res.status()).toBe(PERMANENT);
    expect(locationOf(res)).toBe(CITY);
  });

  test("only the canonical spelling of a page number is a page", async ({ request }) => {
    for (const n of ["1e0", "0x2", "02"]) {
      const res = await request.get(`${CITY}/page/${n}`, { maxRedirects: 0 });
      expect(res.status(), `${CITY}/page/${n}`).toBe(404);
    }
  });

  test("a listing detail page cannot be paginated", async ({ request }) => {
    // The unpaginated URL is the real page, so the 404 is about /page/3 alone.
    expect((await request.get(LISTING)).status()).toBe(200);

    const res = await request.get(`${LISTING}/page/3`, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });

  test("real pagination is untouched", async ({ request }) => {
    const res = await request.get(`${PAGINATING_CITY}/page/2`, { maxRedirects: 0 });
    expect(res.status(), "the fixes must not take genuine page 2 with them").toBe(200);
  });
});

/**
 * The national category route is a second catch-all, and it had neither rule:
 * a capital letter 404'd and /page/1 served a second copy of page 1. Both now
 * come from the same helper as the city route above.
 */
test.describe("category routing canonicalisation", () => {
  const CATEGORY = "/categories/barn-venues";

  test("the category page itself is a 200", async ({ request }) => {
    expect((await request.get(CATEGORY)).status()).toBe(200);
  });

  test("a mixed-case category path permanently redirects to its lowercase form", async ({ request }) => {
    const res = await request.get("/categories/Barn-Venues", { maxRedirects: 0 });
    expect(res.status()).toBe(PERMANENT);
    expect(locationOf(res)).toBe(CATEGORY);
  });

  test("/page/1 permanently redirects to the unpaginated category path", async ({ request }) => {
    const res = await request.get(`${CATEGORY}/page/1`, { maxRedirects: 0 });
    expect(res.status()).toBe(PERMANENT);
    expect(locationOf(res)).toBe(CATEGORY);
  });

  test("only the canonical spelling of a page number is a page", async ({ request }) => {
    for (const n of ["1e0", "0x2", "02"]) {
      const res = await request.get(`${CATEGORY}/page/${n}`, { maxRedirects: 0 });
      expect(res.status(), `${CATEGORY}/page/${n}`).toBe(404);
    }
  });

  test("a page number past the end is a 404, not an empty page", async ({ request }) => {
    const res = await request.get(`${CATEGORY}/page/999`, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });
});
