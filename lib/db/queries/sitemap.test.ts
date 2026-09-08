import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { sitemapCities, sitemapListings, sitemapCategories } from "./sitemap";
import { cities } from "@/lib/db/schema";
import { makeVertical, makeCity, makeCategoryInCity, makeListing } from "@/test/factories";

describe("sitemap queries", () => {
  it("excludes a city that has not earned indexing", async () => {
    await withTestDb(async (tx) => {
      const good = await makeCity(tx, "Leeds", "West Yorkshire");
      await makeCity(tx, "Thintown", "Nowhere");
      await tx.update(cities).set({ isIndexable: true }).where(eq(cities.id, good));
      expect((await sitemapCities(tx)).map((e) => e.path)).toEqual(["/leeds"]);
    });
  });

  it("excludes listings in a noindexed city — no orphan URLs in the sitemap", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const thin = await makeCity(tx, "Thintown", "Nowhere");
      const cat = await makeCategoryInCity(tx, v, thin, "Barn Venues");
      await makeListing(tx, { cityId: thin, verticalId: v, primaryCategoryId: cat }, { name: "Hidden" });
      expect(await sitemapListings(tx)).toHaveLength(0);
    });
  });

  it("includes listings once their city becomes indexable", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, city, "Barn Venues");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { name: "The Barn" });
      await tx.update(cities).set({ isIndexable: true }).where(eq(cities.id, city));
      expect((await sitemapListings(tx)).map((e) => e.path)).toEqual(["/leeds/the-barn"]);
    });
  });

  it("excludes unpublished listings", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, city, "Barn Venues");
      await tx.update(cities).set({ isIndexable: true }).where(eq(cities.id, city));
      for (const status of ["draft", "pending", "rejected", "archived", "removed"] as const) {
        await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { status, name: `x ${status}` });
      }
      expect(await sitemapListings(tx)).toHaveLength(0);
    });
  });

  it("returns paths that are absolute-ready and never contain a region", async () => {
    await withTestDb(async (tx) => {
      const city = await makeCity(tx, "Richmond", "North Yorkshire");
      await tx.update(cities).set({ isIndexable: true }).where(eq(cities.id, city));
      const [entry] = await sitemapCities(tx);
      expect(entry?.path.startsWith("/")).toBe(true);
      expect(entry?.path).not.toContain("north-yorkshire");
    });
  });

  it("lists active categories", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      await makeCategoryInCity(tx, v, city, "Barn Venues");
      expect((await sitemapCategories(tx)).map((e) => e.path)).toEqual(["/categories/barn-venues"]);
    });
  });
});
