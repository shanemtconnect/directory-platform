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
        .toEqual({ kind: "pillar", scope: { type: "city", cityId } });
    });
  });

  it("resolves /[city]/[category] to a city-category pillar", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), categoryId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "Barn Venues", kind: "category", entityId: categoryId });
      expect(await resolveRoute(tx, ["leeds", "barn-venues"], "niche-national"))
        .toEqual({ kind: "pillar", scope: { type: "city-category", cityId, categoryId } });
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
        .toEqual({ kind: "pillar", scope: { type: "vertical", verticalId } });
    });
  });

  it("distinguishes /[vertical]/[area] from /[vertical]/[listing]", async () => {
    await withTestDb(async (tx) => {
      const verticalId = randomUUID(), areaId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Plumbers", kind: "vertical", entityId: verticalId });
      await allocateSlug(tx, { parentScope: verticalId, desired: "St Helier", kind: "area", entityId: areaId });
      await allocateSlug(tx, { parentScope: verticalId, desired: "Bob's Plumbing", kind: "listing", entityId: listingId });

      expect(await resolveRoute(tx, ["plumbers", "st-helier"], "local-multi-vertical"))
        .toEqual({ kind: "pillar", scope: { type: "vertical-area", verticalId, areaId } });
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
