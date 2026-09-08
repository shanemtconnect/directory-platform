import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb } from "@/test/db";
import { allocateSlug, seedReservedSlugs, ROOT_SCOPE } from "./slugs";
import { resolveRoute } from "./resolve";
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
