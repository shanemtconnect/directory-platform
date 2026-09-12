import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb } from "@/test/db";
import { allocateSlug, seedReservedSlugs, ROOT_SCOPE } from "./slugs";
import { resolveRoute, splitPagination, normalisePathSegments, MAX_PAGE_NUMBER } from "./resolve";
import { redirects } from "@/lib/db/schema";

describe("resolveRoute — niche-national", () => {
  it("resolves /[city] to a city pillar", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      expect(await resolveRoute(tx, ["leeds"], "niche-national"))
        .toEqual({ kind: "pillar", page: 1, scope: { type: "city", cityId } });
    });
  });

  it("resolves /[city]/[category] to a city-category pillar", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), categoryId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "Barn Venues", kind: "category", entityId: categoryId });
      expect(await resolveRoute(tx, ["leeds", "barn-venues"], "niche-national"))
        .toEqual({ kind: "pillar", page: 1, scope: { type: "city-category", cityId, categoryId } });
    });
  });

  it("resolves /[city]/[listing] to a listing", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "The Barn", kind: "listing", entityId: listingId });
      expect(await resolveRoute(tx, ["leeds", "the-barn"], "niche-national"))
        .toEqual({ kind: "listing", listingId, parentId: cityId });
    });
  });

  it("returns not-found for an unknown city", async () => {
    await withTestDb(async (tx) => {
      expect(await resolveRoute(tx, ["atlantis"], "niche-national")).toEqual({ kind: "not-found" });
    });
  });

  it("returns not-found for a reserved slug — static routes never reach the resolver", async () => {
    await withTestDb(async (tx) => {
      await seedReservedSlugs(tx);
      expect(await resolveRoute(tx, ["pricing"], "niche-national")).toEqual({ kind: "not-found" });
    });
  });

  it("prefers a redirect over a 404", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(redirects).values({ fromPath: "/kingston", toPath: "/kingston-upon-thames", statusCode: 301 });
      expect(await resolveRoute(tx, ["kingston"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/kingston-upon-thames", status: 301 });
    });
  });

  it("finds a redirect on a two-segment path too", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await tx.insert(redirects).values({ fromPath: "/leeds/old-barn", toPath: "/leeds/the-barn", statusCode: 301 });
      expect(await resolveRoute(tx, ["leeds", "old-barn"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/leeds/the-barn", status: 301 });
    });
  });

  it("rejects paths deeper than two segments", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      expect(await resolveRoute(tx, ["leeds", "a", "b"], "niche-national")).toEqual({ kind: "not-found" });
    });
  });

  it("does not resolve a vertical at the root in niche-national mode", async () => {
    await withTestDb(async (tx) => {
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Plumbers", kind: "vertical", entityId: randomUUID() });
      expect(await resolveRoute(tx, ["plumbers"], "niche-national")).toEqual({ kind: "not-found" });
    });
  });

  it("returns not-found for an empty path", async () => {
    await withTestDb(async (tx) => {
      expect(await resolveRoute(tx, [], "niche-national")).toEqual({ kind: "not-found" });
    });
  });
});

describe("resolveRoute — local-multi-vertical", () => {
  it("resolves /[vertical] to a vertical pillar", async () => {
    await withTestDb(async (tx) => {
      const verticalId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Plumbers", kind: "vertical", entityId: verticalId });
      expect(await resolveRoute(tx, ["plumbers"], "local-multi-vertical"))
        .toEqual({ kind: "pillar", page: 1, scope: { type: "vertical", verticalId } });
    });
  });

  it("distinguishes /[vertical]/[area] from /[vertical]/[listing]", async () => {
    await withTestDb(async (tx) => {
      const verticalId = randomUUID(), areaId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Plumbers", kind: "vertical", entityId: verticalId });
      await allocateSlug(tx, { parentScope: verticalId, desired: "St Helier", kind: "area", entityId: areaId });
      await allocateSlug(tx, { parentScope: verticalId, desired: "Bob's Plumbing", kind: "listing", entityId: listingId });

      expect(await resolveRoute(tx, ["plumbers", "st-helier"], "local-multi-vertical"))
        .toEqual({ kind: "pillar", page: 1, scope: { type: "vertical-area", verticalId, areaId } });
      expect(await resolveRoute(tx, ["plumbers", "bobs-plumbing"], "local-multi-vertical"))
        .toEqual({ kind: "listing", listingId, parentId: verticalId });
    });
  });

  it("does not resolve a city at the root in local-multi-vertical mode", async () => {
    await withTestDb(async (tx) => {
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: randomUUID() });
      expect(await resolveRoute(tx, ["leeds"], "local-multi-vertical")).toEqual({ kind: "not-found" });
    });
  });
});

describe("path pagination", () => {
  it("reads /[city]/page/2 as page 2 of the city pillar", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      expect(await resolveRoute(tx, ["leeds", "page", "2"], "niche-national"))
        .toEqual({ kind: "pillar", page: 2, scope: { type: "city", cityId } });
    });
  });

  it("reads /[city]/[category]/page/3", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), categoryId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "Barn Venues", kind: "category", entityId: categoryId });
      expect(await resolveRoute(tx, ["leeds", "barn-venues", "page", "3"], "niche-national"))
        .toEqual({ kind: "pillar", page: 3, scope: { type: "city-category", cityId, categoryId } });
    });
  });

  it("defaults to page 1 with no page segment", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      const r = await resolveRoute(tx, ["leeds"], "niche-national");
      expect(r.kind === "pillar" && r.page).toBe(1);
    });
  });

  it("treats a non-numeric or zero page as not-found rather than page 1", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      expect(await resolveRoute(tx, ["leeds", "page", "abc"], "niche-national")).toEqual({ kind: "not-found" });
      expect(await resolveRoute(tx, ["leeds", "page", "0"], "niche-national")).toEqual({ kind: "not-found" });
    });
  });

  it("cannot be shadowed by a listing called Page", async () => {
    await withTestDb(async (tx) => {
      await expect(allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Page", kind: "city", entityId: randomUUID(),
      })).rejects.toThrow(/reserved/i);
    });
  });
});

describe("pagination canonicalisation", () => {
  it("301s /[city]/page/1 to the unpaginated path", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      expect(await resolveRoute(tx, ["leeds", "page", "1"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/leeds", status: 301 });
    });
  });

  it("301s /[city]/[category]/page/1 to the category path", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), categoryId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "Barn Venues", kind: "category", entityId: categoryId });
      expect(await resolveRoute(tx, ["leeds", "barn-venues", "page", "1"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/leeds/barn-venues", status: 301 });
    });
  });

  it("rejects every non-canonical spelling of a page number", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      // Number() accepts all of these, each one an extra URL serving page 2.
      for (const n of ["1e0", "0x2", "02", " 2", "+2", "2.0", "2 ", "1_0"]) {
        expect(await resolveRoute(tx, ["leeds", "page", n], "niche-national"), n)
          .toEqual({ kind: "not-found" });
      }
    });
  });

  it("never paginates a listing", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Truro", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "The Grange Estate", kind: "listing", entityId: listingId });
      expect(await resolveRoute(tx, ["truro", "the-grange-estate", "page", "3"], "niche-national"))
        .toEqual({ kind: "not-found" });
    });
  });

  it("returns not-found for a page number no directory could have", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      // Bounded BEFORE the query, not after. The pillar page runs listListings
      // and countListings with OFFSET (page - 1) * perPage and only then checks
      // the page against the real total, so an unbounded number here is a deep
      // offset scan Postgres performs in full before anything 404s — free for
      // anyone who can type a URL. 20 digits also overflows a bigint and
      // Number() rounds it, so the OFFSET Postgres receives is not even the
      // number that was asked for.
      for (const n of ["10001", "1000000", "99999999999999999999"]) {
        expect(await resolveRoute(tx, ["leeds", "page", n], "niche-national"), n)
          .toEqual({ kind: "not-found" });
      }
    });
  });

  it("still serves the last page number a real directory could reach", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      // The bound must not become the thing that 404s a genuine page. 10,000
      // pages is far past any real city, and the page-past-the-end check in the
      // route is what handles everything below it.
      const r = await resolveRoute(tx, ["leeds", "page", "10000"], "niche-national");
      expect(r).toEqual({ kind: "pillar", page: 10000, scope: { type: "city", cityId } });
    });
  });

  it("returns not-found for a bare /page/N", async () => {
    await withTestDb(async (tx) => {
      expect(await resolveRoute(tx, ["page", "1"], "niche-national")).toEqual({ kind: "not-found" });
      expect(await resolveRoute(tx, ["page", "2"], "niche-national")).toEqual({ kind: "not-found" });
    });
  });
});

describe("case canonicalisation", () => {
  it("301s a mixed-case path to its lowercase form", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      expect(await resolveRoute(tx, ["Leeds"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/leeds", status: 301 });
    });
  });

  it("lowercases every segment, including the page marker", async () => {
    await withTestDb(async (tx) => {
      expect(await resolveRoute(tx, ["Leeds", "Barn-Venues", "PAGE", "2"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/leeds/barn-venues/page/2", status: 301 });
    });
  });

  it("leaves an already-lowercase path alone", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      expect(await resolveRoute(tx, ["leeds"], "niche-national"))
        .toEqual({ kind: "pillar", page: 1, scope: { type: "city", cityId } });
    });
  });

  it("matches a redirect row case-insensitively", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(redirects).values({ fromPath: "/kingston", toPath: "/kingston-upon-thames", statusCode: 301 });
      // Case is canonicalised first, so /KINGSTON 301s to /kingston, which then
      // 301s on to the rename target — two hops, but never a 404.
      expect(await resolveRoute(tx, ["KINGSTON"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/kingston", status: 301 });
      expect(await resolveRoute(tx, ["kingston"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/kingston-upon-thames", status: 301 });
    });
  });
});

describe("redirect status pass-through", () => {
  it("carries the stored status code out of the resolver", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(redirects).values({ fromPath: "/moved", toPath: "/elsewhere", statusCode: 308 });
      await tx.insert(redirects).values({ fromPath: "/temporary", toPath: "/elsewhere", statusCode: 307 });
      await tx.insert(redirects).values({ fromPath: "/gone", toPath: "/gone", statusCode: 410 });

      expect(await resolveRoute(tx, ["moved"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/elsewhere", status: 308 });
      expect(await resolveRoute(tx, ["temporary"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/elsewhere", status: 307 });
      expect(await resolveRoute(tx, ["gone"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/gone", status: 410 });
    });
  });

  it("refuses a status code the router cannot serve", async () => {
    await withTestDb(async (tx) => {
      await expect(
        tx.insert(redirects).values({ fromPath: "/bad", toPath: "/elsewhere", statusCode: 404 }),
      ).rejects.toThrow();
    });
  });
});

describe("root-scope prefix redirects", () => {
  it("carries a renamed city's redirect over its whole subtree", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(redirects).values({ fromPath: "/kingston", toPath: "/kingston-upon-thames", statusCode: 301 });
      expect(await resolveRoute(tx, ["kingston", "the-barn"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/kingston-upon-thames/the-barn", status: 301 });
      expect(await resolveRoute(tx, ["kingston", "barn-venues", "page", "2"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/kingston-upon-thames/barn-venues/page/2", status: 301 });
    });
  });

  it("prefers an exact redirect row over the prefix rule", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(redirects).values({ fromPath: "/kingston", toPath: "/kingston-upon-thames", statusCode: 301 });
      await tx.insert(redirects).values({ fromPath: "/kingston/the-barn", toPath: "/leeds/the-barn", statusCode: 301 });
      expect(await resolveRoute(tx, ["kingston", "the-barn"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/leeds/the-barn", status: 301 });
    });
  });

  it("does not turn a gone city into a redirect loop over its children", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(redirects).values({ fromPath: "/atlantis", toPath: "/atlantis", statusCode: 410 });
      expect(await resolveRoute(tx, ["atlantis", "the-barn"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/atlantis", status: 410 });
    });
  });

  it("still 404s a child of a city that was never renamed", async () => {
    await withTestDb(async (tx) => {
      expect(await resolveRoute(tx, ["atlantis", "the-barn"], "niche-national"))
        .toEqual({ kind: "not-found" });
    });
  });

  it("does not apply the prefix rule under a live city", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await tx.insert(redirects).values({ fromPath: "/leeds", toPath: "/leeds-west-yorkshire", statusCode: 301 });
      expect(await resolveRoute(tx, ["leeds", "no-such-listing"], "niche-national"))
        .toEqual({ kind: "not-found" });
    });
  });
});

/**
 * `splitPagination` is shared by the city catch-all and app/categories/[...category],
 * so the bound has to live here rather than in either route.
 */
describe("splitPagination bounds", () => {
  it("bounds at a number no real directory reaches", () => {
    expect(MAX_PAGE_NUMBER).toBe(10_000);
  });

  it("accepts page numbers a directory can actually reach", () => {
    expect(splitPagination(["leeds", "page", "2"]))
      .toEqual({ rest: ["leeds"], page: 2, explicit: true });
    expect(splitPagination(["leeds", "page", "10000"]))
      .toEqual({ rest: ["leeds"], page: 10000, explicit: true });
  });

  it("returns null past MAX_PAGE_NUMBER", () => {
    expect(splitPagination(["leeds", "page", "10001"])).toBeNull();
    expect(splitPagination(["leeds", "page", "1000000"])).toBeNull();
  });

  it("rejects on digit count before Number() is ever called", () => {
    // 2^53 and beyond: Number() rounds these silently, so a value-only check
    // would be comparing a number nobody asked for. Longer still and the OFFSET
    // overflows a bigint in Postgres.
    for (const n of ["9007199254740993", "99999999999999999999", "1".repeat(400)]) {
      expect(splitPagination(["leeds", "page", n]), n).toBeNull();
    }
  });

  it("is what the category route inherits the bound from", () => {
    expect(normalisePathSegments("/categories", ["barn-venues", "page", "1000000"]))
      .toEqual({ kind: "not-found" });
    expect(normalisePathSegments("/categories", ["barn-venues", "page", "2"]))
      .toEqual({
        kind: "ok",
        segments: ["barn-venues"],
        lowered: ["barn-venues", "page", "2"],
        page: 2,
      });
  });
});

/**
 * The reviews sub-page is the only thing that hangs off a listing URL, and it
 * has to obey every rule the rest of the resolver already does — case, /page/1,
 * the page bound — without loosening the "a listing is exactly two segments"
 * rule that keeps /[city]/[category]/[listing] a 404.
 */
describe("listing reviews sub-page", () => {
  it("resolves /[city]/[listing]/reviews", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "The Barn", kind: "listing", entityId: listingId });
      expect(await resolveRoute(tx, ["leeds", "the-barn", "reviews"], "niche-national"))
        .toEqual({ kind: "listing-reviews", listingId, parentId: cityId, page: 1 });
    });
  });

  it("paginates with /page/N like every other list on the site", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "The Barn", kind: "listing", entityId: listingId });
      expect(await resolveRoute(tx, ["leeds", "the-barn", "reviews", "page", "3"], "niche-national"))
        .toEqual({ kind: "listing-reviews", listingId, parentId: cityId, page: 3 });
    });
  });

  it("301s /reviews/page/1 to the unpaginated reviews path", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "The Barn", kind: "listing", entityId: listingId });
      expect(await resolveRoute(tx, ["leeds", "the-barn", "reviews", "page", "1"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/leeds/the-barn/reviews", status: 301 });
    });
  });

  it("301s a mixed-case reviews path to lowercase", async () => {
    await withTestDb(async (tx) => {
      expect(await resolveRoute(tx, ["Leeds", "The-Barn", "Reviews"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/leeds/the-barn/reviews", status: 301 });
    });
  });

  it("still bounds the page number", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "The Barn", kind: "listing", entityId: listingId });
      expect(
        await resolveRoute(
          tx, ["leeds", "the-barn", "reviews", "page", String(MAX_PAGE_NUMBER + 1)], "niche-national",
        ),
      ).toEqual({ kind: "not-found" });
    });
  });

  it("does not hang a reviews page off a category", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), categoryId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "Barn Venues", kind: "category", entityId: categoryId });
      expect(await resolveRoute(tx, ["leeds", "barn-venues", "reviews"], "niche-national"))
        .toEqual({ kind: "not-found" });
    });
  });

  it("still honours a redirect row for a category reviews path", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), categoryId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "Barn Venues", kind: "category", entityId: categoryId });
      // A category has no reviews page, but a path that once existed and was
      // redirected must not lose its redirect just because the third segment
      // happens to be the word the resolver reserves.
      await tx.insert(redirects).values({
        fromPath: "/leeds/barn-venues/reviews",
        toPath: "/leeds/barn-venues",
        statusCode: 301,
      });
      expect(await resolveRoute(tx, ["leeds", "barn-venues", "reviews"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/leeds/barn-venues", status: 301 });
    });
  });

  it("keeps any other third segment a 404", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "The Barn", kind: "listing", entityId: listingId });
      expect(await resolveRoute(tx, ["leeds", "the-barn", "photos"], "niche-national"))
        .toEqual({ kind: "not-found" });
    });
  });

  it("leaves the plain listing URL unpaginated", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "The Barn", kind: "listing", entityId: listingId });
      expect(await resolveRoute(tx, ["leeds", "the-barn", "page", "2"], "niche-national"))
        .toEqual({ kind: "not-found" });
    });
  });

  it("works the same way under a vertical in local-multi-vertical mode", async () => {
    await withTestDb(async (tx) => {
      const verticalId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Plumbers", kind: "vertical", entityId: verticalId });
      await allocateSlug(tx, { parentScope: verticalId, desired: "Ace Plumbing", kind: "listing", entityId: listingId });
      expect(await resolveRoute(tx, ["plumbers", "ace-plumbing", "reviews"], "local-multi-vertical"))
        .toEqual({ kind: "listing-reviews", listingId, parentId: verticalId, page: 1 });
    });
  });

  it("prefers an exact redirect row over resolving the reviews path", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await tx.insert(redirects).values({
        fromPath: "/leeds/old-barn/reviews", toPath: "/leeds/the-barn/reviews", statusCode: 301,
      });
      expect(await resolveRoute(tx, ["leeds", "old-barn", "reviews"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/leeds/the-barn/reviews", status: 301 });
    });
  });
});
