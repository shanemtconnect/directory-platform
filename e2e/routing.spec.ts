import { expect, test, type APIResponse } from "@playwright/test";
import { anyCategorySlug, anyListingPath, paginatingCity, quietCity } from "./fixtures";

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
 * CITY is `quietCity()` — any city that is one page deep works here, and
 * quietCity is guaranteed to be (it is the fewest-listings city). CATEGORY,
 * LISTING and PAGINATING_CITY come from the matching fixtures, filled in
 * `beforeAll` below rather than named, so this suite runs against whatever
 * niche the repo has been cloned into.
 *
 * The permanent redirects are asserted as 308 rather than 301: next/navigation
 * has no way to emit a 301 from a server component, and 308 is the same
 * permanent signal — it just also forbids rewriting the method.
 *
 * `locationOf` asserts ONE `Location` line, not merely one destination.
 *
 * It used to tolerate two, because on a cold response (`x-nextjs-cache: MISS`)
 * Next 16.3.4 emitted `Location` twice with the same value: the redirect write
 * from the render, plus the same header replayed from the fresh cache entry.
 * That is fixed in lib/boot/location-header.ts, and this assertion is what
 * keeps it fixed — a recipient may fold repeated field lines into one
 * comma-joined value, which turns e.g. `/a-city` into `/a-city, /a-city`.
 *
 * Verified cold by hand as well as here: flush the ISR namespace, start the
 * standalone server, and `curl -sI http://localhost:PORT/<Mixed-Case-City>` —
 * one `location: /<city>` beside `x-nextjs-cache: MISS`. The first test below
 * forces a cold key of its own so a warm server cannot hide a regression.
 */

function locationOf(res: APIResponse): string {
  const values = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "location")
    .map((h) => h.value);

  expect(
    values,
    `expected exactly one Location line (x-nextjs-cache: ${res.headers()["x-nextjs-cache"] ?? "none"})`,
  ).toHaveLength(1);
  return values[0]!;
}

/**
 * A case spelling of a slug that this run has almost certainly never asked for.
 *
 * The ISR cache is keyed on the pathname, so a fresh spelling is a fresh key
 * and therefore a genuine `MISS` — the only state in which the doubled
 * `Location` ever appeared. There are 2^n spellings of an n-letter slug, so a
 * repeat is possible; it would only cost this one test its coldness, never
 * its correctness.
 *
 * One letter is forced upper so the result is always a redirect — the
 * all-lowercase draw is the canonical path and answers 200.
 */
function randomCasing(slug: string): string {
  const forced = Math.floor(Math.random() * slug.length);
  return [...slug]
    .map((c, i) => (i === forced || Math.random() < 0.5 ? c.toUpperCase() : c))
    .join("");
}

/** "barn-venues" -> "Barn-Venues", "leeds" -> "Leeds": upper-cases each hyphen-separated segment. */
function mixedCase(slug: string): string {
  return slug
    .split("-")
    .map((segment) => (segment.length === 0 ? segment : segment[0]!.toUpperCase() + segment.slice(1)))
    .join("-");
}

let CITY: string;
let CITY_SLUG: string;
let PAGINATING_CITY: string;
let LISTING: string;
let CATEGORY: string;
let CATEGORY_SLUG: string;

test.beforeAll(async () => {
  const city = await quietCity();
  CITY = city.path;
  CITY_SLUG = city.slug;
  PAGINATING_CITY = (await paginatingCity()).path;
  LISTING = await anyListingPath();
  CATEGORY_SLUG = await anyCategorySlug();
  CATEGORY = `/categories/${CATEGORY_SLUG}`;
});

const PERMANENT = 308;

test.describe("routing canonicalisation", () => {
  test("a page number past the end is a 404, not an empty page", async ({ request }) => {
    const res = await request.get(`${CITY}/page/999`, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });

  test("a mixed-case path permanently redirects to its lowercase form", async ({ request }) => {
    const res = await request.get(`/${mixedCase(CITY_SLUG)}`, { maxRedirects: 0 });
    expect(res.status()).toBe(PERMANENT);
    expect(locationOf(res)).toBe(CITY);
  });

  test("a COLD mixed-case redirect emits exactly one Location", async ({ request }) => {
    // The regression this guards is cache-state-dependent: Next emitted the
    // header twice only on a MISS. An unseen spelling is how the test gets one
    // without flushing a cache the rest of the suite is sharing — asserting
    // `x-nextjs-cache: MISS` below is what makes that "cold" claim checked
    // rather than assumed; without it this test could quietly start
    // exercising a HIT (the one state the bug never occurred in) and still
    // pass.
    const spelling = randomCasing(CITY_SLUG);
    const res = await request.get(`/${spelling}`, { maxRedirects: 0 });
    expect(res.status(), `/${spelling}`).toBe(PERMANENT);
    expect(res.headers()["x-nextjs-cache"], `/${spelling}`).toBe("MISS");
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

  test("an absurd page number 404s without querying for it", async ({ request }) => {
    // /page/999 above is past the end but still plausible; these are the ones
    // that reach Postgres as a deep OFFSET before anything can 404 them.
    // 1000000 is 20 million rows of index walked and discarded per request, and
    // the 20-digit form both overflows the bigint the OFFSET binds to and is
    // already rounded by the time JavaScript sees it — a 500 where a 404
    // belongs. Both are rejected in splitPagination, before a query runs.
    for (const n of ["1000000", "99999999999999999999"]) {
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
  test("the category page itself is a 200", async ({ request }) => {
    expect((await request.get(CATEGORY)).status()).toBe(200);
  });

  test("a mixed-case category path permanently redirects to its lowercase form", async ({ request }) => {
    const res = await request.get(`/categories/${mixedCase(CATEGORY_SLUG)}`, { maxRedirects: 0 });
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
