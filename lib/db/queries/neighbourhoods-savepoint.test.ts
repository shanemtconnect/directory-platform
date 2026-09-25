import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { makeCity, makeListing, makeNeighbourhood, makeScaffold } from "@/test/factories";
import { listings } from "@/lib/db/schema";

/**
 * One town failing must not roll back the others (Task 52 review): each town
 * is assigned inside its own savepoint. The failure is a real database error
 * — a foreign-key violation from an `area_id` that names no area — made by
 * steering the centroid rule for the town whose neighbourhood is "boom".
 */
vi.mock("@/lib/geo/neighbourhoods", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/geo/neighbourhoods")>();
  return {
    ...real,
    nearestNeighbourhood: (point: { lat: number; lng: number }, candidates: readonly { slug: string }[]) =>
      candidates.some((c) => c.slug === "boom")
        ? "3f2b8a61-0000-4000-8000-00000000dead"
        : real.nearestNeighbourhood(point, candidates as never),
  };
});

const { assignNeighbourhoods } = await import("./neighbourhoods");
const WORKER = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" } as const;
const CENTRE = { lat: 53.8, lng: -1.55 };

async function areaOf(tx: TestDb, id: string) {
  const [l] = await tx.select({ areaId: listings.areaId }).from(listings).where(eq(listings.id, id));
  return l!.areaId;
}

describe("assignNeighbourhoods — one savepoint per town", () => {
  it("keeps the towns that worked when another town fails, and names the one that failed", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const good = await makeNeighbourhood(tx, ctx.cityId, "Headingley", { ...CENTRE, radiusKm: 2 });
      const inGood = await makeListing(tx, ctx, { name: "Good", ...CENTRE });

      const badCity = await makeCity(tx, "York", "North Yorkshire");
      await makeNeighbourhood(tx, badCity, "Boom", { slug: "boom", ...CENTRE, radiusKm: 2 });
      const inBad = await makeListing(tx, { ...ctx, cityId: badCity }, { name: "Bad", ...CENTRE });

      const out = await assignNeighbourhoods(tx, WORKER);

      expect(await areaOf(tx, inGood)).toBe(good);
      expect(await areaOf(tx, inBad)).toBeNull();
      expect(out.failed).toHaveLength(1);
      expect(out.cities).toBe(2);
    });
  });
});
