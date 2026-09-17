import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { cities, listings } from "@/lib/db/schema";
import { makeListing, makeScaffold } from "@/test/factories";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { listingPaths } from "./paths";

describe("listingPaths", () => {
  it("returns the listing page, its reviews page and the city page", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });
      const [city] = await tx.select({ slug: cities.slug }).from(cities).where(eq(cities.id, ctx.cityId));

      const paths = await listingPaths(tx, ADMIN_VIEWER, listingId);

      expect(paths).toEqual([
        `/${city!.slug}/the-old-mill`,
        `/${city!.slug}/the-old-mill/reviews`,
        `/${city!.slug}`,
      ]);
    });
  });

  it("still answers for a listing that is no longer published — a lapse is exactly when the cache is stale", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Gone", status: "removed" });
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, listingId));

      const paths = await listingPaths(tx, ADMIN_VIEWER, listingId);
      expect(paths).toHaveLength(3);
      expect(paths[0]).toMatch(/\/gone$/);
    });
  });

  it("returns nothing for an unknown or malformed id", async () => {
    await withTestDb(async (tx) => {
      expect(await listingPaths(tx, ADMIN_VIEWER, "11111111-1111-4111-8111-111111111111")).toEqual([]);
      expect(await listingPaths(tx, ADMIN_VIEWER, "not-a-uuid")).toEqual([]);
    });
  });

  it("is worker-only", async () => {
    await withTestDb(async (tx) => {
      await expect(
        listingPaths(tx, PUBLIC_VIEWER, "11111111-1111-4111-8111-111111111111"),
      ).rejects.toThrow("FORBIDDEN");
    });
  });
});
