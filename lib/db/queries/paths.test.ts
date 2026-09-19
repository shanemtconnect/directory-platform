import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { cities, listings } from "@/lib/db/schema";
import { makeCategory, makeListing, makeScaffold } from "@/test/factories";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { PER_PAGE } from "./listings";
import { listingPaths, resolveListingPaths } from "./paths";

async function citySlug(tx: Parameters<typeof listingPaths>[0], cityId: string): Promise<string> {
  const [city] = await tx.select({ slug: cities.slug }).from(cities).where(eq(cities.id, cityId));
  return city!.slug;
}

describe("listingPaths", () => {
  it("returns the listing page, its reviews page, the city page and the city's pillar page", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });
      const city = await citySlug(tx, ctx.cityId);

      const paths = await listingPaths(tx, ADMIN_VIEWER, listingId);

      expect(paths).toEqual([
        `/${city}/the-old-mill`,
        `/${city}/the-old-mill/reviews`,
        `/${city}`,
        `/${city}/barn-venues`,
      ]);
    });
  });

  it("includes every paginated city page that exists, and none that do not", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const city = await citySlug(tx, ctx.cityId);
      // Two full pages and one on a third.
      const ids: string[] = [];
      for (let i = 0; i < PER_PAGE * 2 + 1; i++) ids.push(await makeListing(tx, ctx));

      const paths = await listingPaths(tx, ADMIN_VIEWER, ids[0]!);

      expect(paths).toContain(`/${city}/page/2`);
      expect(paths).toContain(`/${city}/page/3`);
      expect(paths).not.toContain(`/${city}/page/4`);
      // /city/page/1 is /city; it 301s and is never a cached page of its own.
      expect(paths).not.toContain(`/${city}/page/1`);
    });
  });

  it("has no paginated pages for a city that fits on one with room to spare", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const city = await citySlug(tx, ctx.cityId);
      const ids: string[] = [];
      // One short of a full page: even the listing this decision may add
      // would not spill onto a second page, so there is none to bust.
      for (let i = 0; i < PER_PAGE - 1; i++) ids.push(await makeListing(tx, ctx));

      const paths = await listingPaths(tx, ADMIN_VIEWER, ids[0]!);

      expect(paths.filter((p) => p.includes("/page/"))).toEqual([]);
    });
  });

  it("counts only published listings towards the page count", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const city = await citySlug(tx, ctx.cityId);
      const ids: string[] = [];
      for (let i = 0; i < PER_PAGE - 1; i++) ids.push(await makeListing(tx, ctx));
      await makeListing(tx, ctx, { status: "pending" });
      await makeListing(tx, ctx, { status: "removed" });

      const paths = await listingPaths(tx, ADMIN_VIEWER, ids[0]!);

      // PER_PAGE - 1 published: even one more would not need a page 2.
      expect(paths).not.toContain(`/${city}/page/2`);
    });
  });

  it("includes the page a growth across the boundary creates", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const city = await citySlug(tx, ctx.cityId);
      const ids: string[] = [];
      for (let i = 0; i < PER_PAGE; i++) ids.push(await makeListing(tx, ctx));

      const paths = await listingPaths(tx, ADMIN_VIEWER, ids[0]!);

      // Exactly PER_PAGE published: approving one more creates /page/2, which
      // may already be cached as a 404 and must be busted.
      expect(paths).toContain(`/${city}/page/2`);
      expect(paths).not.toContain(`/${city}/page/3`);
    });
  });

  it("leaves the pillar page out when the category is not routed in that city", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const unrouted = await makeCategory(tx, ctx.verticalId, "Halls");
      const listingId = await makeListing(tx, ctx, {
        name: "The Hall",
        primaryCategoryId: unrouted,
      });
      const city = await citySlug(tx, ctx.cityId);

      const paths = await listingPaths(tx, ADMIN_VIEWER, listingId);

      expect(paths).toEqual([`/${city}/the-hall`, `/${city}/the-hall/reviews`, `/${city}`]);
    });
  });

  it("still answers for a listing that is no longer published — a lapse is exactly when the cache is stale", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Gone", status: "removed" });
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, listingId));

      const paths = await listingPaths(tx, ADMIN_VIEWER, listingId);
      expect(paths).toHaveLength(4);
      expect(paths[0]).toMatch(/\/gone$/);
    });
  });

  it("returns nothing for an unknown or malformed id", async () => {
    await withTestDb(async (tx) => {
      expect(await listingPaths(tx, ADMIN_VIEWER, "11111111-1111-4111-8111-111111111111")).toEqual([]);
      expect(await listingPaths(tx, ADMIN_VIEWER, "not-a-uuid")).toEqual([]);
    });
  });

  it("resolveListingPaths is the same list with no viewer gate, for query functions that have already authorised", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });

      const gated = await listingPaths(tx, ADMIN_VIEWER, listingId);
      const ungated = await resolveListingPaths(tx, listingId);

      expect(ungated).toEqual(gated);
      expect(ungated.length).toBeGreaterThan(0);
      expect(await resolveListingPaths(tx, "not-a-uuid")).toEqual([]);
    });
  });

  it("is admin-only", async () => {
    await withTestDb(async (tx) => {
      await expect(
        listingPaths(tx, PUBLIC_VIEWER, "11111111-1111-4111-8111-111111111111"),
      ).rejects.toThrow("FORBIDDEN");
    });
  });
});
