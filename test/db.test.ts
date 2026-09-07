import { describe, it, expect } from "vitest";
import { withTestDb } from "./db";
import { cities, verticals } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

describe("withTestDb", () => {
  it("returns the callback's value", async () => {
    expect(await withTestDb(async () => 42)).toBe(42);
  });

  it("rolls back writes so tests cannot contaminate each other", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(cities).values({ name: "Rollbackton", slug: "rollbackton", country: "GB" });
      expect(await tx.select().from(cities).where(eq(cities.slug, "rollbackton"))).toHaveLength(1);
    });
    await withTestDb(async (tx) => {
      expect(await tx.select().from(cities).where(eq(cities.slug, "rollbackton"))).toHaveLength(0);
    });
  });

  it("propagates a real error rather than swallowing it as a rollback", async () => {
    await expect(withTestDb(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  it("enforces the schema's not-null and unique constraints", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(verticals).values({
        name: "Venues", slug: "venues", singular: "venue", plural: "venues",
        ownerNoun: "venue owner", schemaType: "EventVenue",
      });
      await expect(
        tx.insert(verticals).values({
          name: "Other", slug: "venues", singular: "x", plural: "y",
          ownerNoun: "z", schemaType: "Thing",
        }),
      ).rejects.toThrow();
    });
  });

  it("defaults a new city to non-indexable — a city must earn indexing", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(cities).values({ name: "Leeds", slug: "leeds", country: "GB" });
      const [row] = await tx.select().from(cities).where(eq(cities.slug, "leeds"));
      expect(row?.isIndexable).toBe(false);
      expect(row?.isPublished).toBe(true);
    });
  });

  it("defaults a new listing's claim status to unclaimed with no rating", async () => {
    await withTestDb(async (tx) => {
      const [v] = await tx.insert(verticals).values({
        name: "Venues", slug: "venues", singular: "venue", plural: "venues",
        ownerNoun: "venue owner", schemaType: "EventVenue",
      }).returning();
      const [c] = await tx.insert(cities).values({ name: "Leeds", slug: "leeds", country: "GB" }).returning();
      const { categories, listings } = await import("@/lib/db/schema");
      const [cat] = await tx.insert(categories).values({
        verticalId: v!.id, name: "Barn", slug: "barn", singular: "barn", plural: "barns",
      }).returning();
      const [l] = await tx.insert(listings).values({
        name: "The Barn", slug: "the-barn", cityId: c!.id,
        verticalId: v!.id, primaryCategoryId: cat!.id,
      }).returning();
      expect(l?.claimStatus).toBe("unclaimed");
      expect(l?.status).toBe("draft");
      expect(l?.tier).toBe("free");
      expect(l?.ratingAvg).toBeNull();
      expect(l?.ratingCount).toBe(0);
    });
  });
});
