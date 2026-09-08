import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { runSeed } from "./seed";
import { cities, categories, listings, slugs } from "@/lib/db/schema";
import { resolveSlug, ROOT_SCOPE } from "@/lib/routing/slugs";
import { eq, and } from "drizzle-orm";

const NICHE = "wedding-venues";

describe("runSeed", () => {
  it("loads 50 cities, 20 categories and 200 listings", async () => {
    await withTestDb(async (tx) => {
      const r = await runSeed(tx, NICHE);
      expect(r.cities).toBe(50);
      expect(r.categories).toBe(20);
      expect(r.listings).toBe(200);
      expect(await tx.select().from(cities)).toHaveLength(50);
      expect(await tx.select().from(categories)).toHaveLength(20);
      expect(await tx.select().from(listings)).toHaveLength(200);
    });
  }, 60000);

  it("is idempotent — running twice adds nothing", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const second = await runSeed(tx, NICHE);
      expect(second.cities).toBe(0);
      expect(second.listings).toBe(0);
      expect(await tx.select().from(cities)).toHaveLength(50);
      expect(await tx.select().from(listings)).toHaveLength(200);
    });
  }, 90000);

  it("seeds no ratings and nothing verified", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx.select().from(listings);
      expect(rows.every((r) => r.ratingAvg === null)).toBe(true);
      expect(rows.every((r) => r.ratingCount === 0)).toBe(true);
      expect(rows.every((r) => r.claimStatus === "unclaimed")).toBe(true);
      expect(rows.every((r) => r.tier === "free")).toBe(true);
    });
  }, 60000);

  it("leaves every city non-indexable until it earns it", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      expect((await tx.select().from(cities)).every((c) => c.isIndexable === false)).toBe(true);
    });
  }, 60000);

  it("disambiguates the two Richmonds rather than dropping one", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx.select().from(cities).where(eq(cities.name, "Richmond"));
      expect(rows).toHaveLength(2);
      const slugsFound = rows.map((r) => r.slug).sort();
      expect(slugsFound[0]).toBe("richmond");
      expect(slugsFound[1]).toMatch(/^richmond-/);
    });
  }, 60000);

  it("allocates a slug row for every city and listing", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      expect(await tx.select().from(slugs).where(eq(slugs.kind, "city"))).toHaveLength(50);
      expect(await tx.select().from(slugs).where(eq(slugs.kind, "listing"))).toHaveLength(200);
    });
  }, 60000);

  it("routes each category inside every city where it has listings", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const [aListing] = await tx.select().from(listings).limit(1);
      const row = await tx.select().from(slugs)
        .where(and(eq(slugs.parentScope, aListing!.cityId), eq(slugs.entityId, aListing!.primaryCategoryId)))
        .limit(1);
      expect(row[0]?.kind).toBe("category");
    });
  }, 60000);

  it("updates the denormalised listing_count the indexing gate reads", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx.select().from(cities);
      const total = rows.reduce((n, c) => n + c.listingCount, 0);
      expect(total).toBe(200);
    });
  }, 60000);

  it("seeds the reserved slugs so a static route can never be shadowed", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      expect((await resolveSlug(tx, ROOT_SCOPE, "pricing"))?.kind).toBe("static");
      expect((await resolveSlug(tx, ROOT_SCOPE, "add-listing"))?.kind).toBe("static");
    });
  }, 60000);
});
