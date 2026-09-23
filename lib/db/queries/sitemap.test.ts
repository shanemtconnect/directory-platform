import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import {
  sitemapCities,
  sitemapListings,
  sitemapCategories,
  countSitemapListings,
  categoryEarnsIndexing,
  sitemapShardIds,
  listingShardIndex,
  shardPath,
  STATIC_SHARD_ID,
  CATEGORY_SHARD_ID,
  SITEMAP_SHARD_SIZE,
} from "./sitemap";
import { cities, categories } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { isReserved } from "@/lib/routing/slugify";
import { makeVertical, makeCity, makeCategoryInCity, makeListing } from "@/test/factories";

const viewer = PUBLIC_VIEWER;

describe("sitemap queries", () => {
  it("excludes a city that has not earned indexing", async () => {
    await withTestDb(async (tx) => {
      const good = await makeCity(tx, "Leeds", "West Yorkshire");
      await makeCity(tx, "Thintown", "Nowhere");
      await tx.update(cities).set({ isIndexable: true }).where(eq(cities.id, good));
      expect((await sitemapCities(tx, viewer)).map((e) => e.path)).toEqual(["/leeds"]);
    });
  });

  it("INCLUDES listings in a city that has not earned indexing", async () => {
    // The gate keeps thin CITY pages out of the index. A listing page has its
    // own unique content, and excluding it would deny a paying owner organic
    // visibility for a reason outside their control.
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const thin = await makeCity(tx, "Thintown", "Nowhere");
      const cat = await makeCategoryInCity(tx, v, thin, "Barn Halls");
      await makeListing(tx, { cityId: thin, verticalId: v, primaryCategoryId: cat }, { name: "Solo" });
      expect((await sitemapListings(tx, viewer)).map((e) => e.path)).toEqual(["/thintown/solo"]);
    });
  });

  it("still excludes listings in an UNPUBLISHED city", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const hidden = await makeCity(tx, "Hiddentown", "Nowhere");
      const cat = await makeCategoryInCity(tx, v, hidden, "Barn Halls");
      await makeListing(tx, { cityId: hidden, verticalId: v, primaryCategoryId: cat }, { name: "Nope" });
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, hidden));
      expect(await sitemapListings(tx, viewer)).toHaveLength(0);
    });
  });

  it("includes listings once their city becomes indexable", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { name: "The Barn" });
      await tx.update(cities).set({ isIndexable: true }).where(eq(cities.id, city));
      expect((await sitemapListings(tx, viewer)).map((e) => e.path)).toEqual(["/leeds/the-barn"]);
    });
  });

  it("excludes unpublished listings", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await tx.update(cities).set({ isIndexable: true }).where(eq(cities.id, city));
      for (const status of ["draft", "pending", "rejected", "archived", "removed"] as const) {
        await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { status, name: `x ${status}` });
      }
      expect(await sitemapListings(tx, viewer)).toHaveLength(0);
      expect(await countSitemapListings(tx, viewer)).toBe(0);
    });
  });

  it("returns paths that are absolute-ready and never contain a region", async () => {
    await withTestDb(async (tx) => {
      const city = await makeCity(tx, "Richmond", "North Yorkshire");
      await tx.update(cities).set({ isIndexable: true }).where(eq(cities.id, city));
      const [entry] = await sitemapCities(tx, viewer);
      expect(entry?.path.startsWith("/")).toBe(true);
      expect(entry?.path).not.toContain("north-yorkshire");
    });
  });

  it("lists a category once it has a published listing", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { name: "The Barn" });
      expect((await sitemapCategories(tx, viewer)).map((e) => e.path)).toEqual(["/categories/barn-halls"]);
    });
  });

  it("omits an EMPTY category, because its own page is noindex", async () => {
    // Advertising a page we have told Google to ignore is crawl budget spent
    // on nothing. The sitemap and the page must apply one rule.
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      await makeCategoryInCity(tx, v, city, "Barn Halls");
      expect(await sitemapCategories(tx, viewer)).toHaveLength(0);
    });
  });

  it("omits a category whose only listings are unpublished", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { status: "draft", name: "Hidden" });
      expect(await sitemapCategories(tx, viewer)).toHaveLength(0);
    });
  });

  it("omits an inactive category even when it has listings", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { name: "The Barn" });
      await tx.update(categories).set({ isActive: false }).where(eq(categories.id, cat));
      expect(await sitemapCategories(tx, viewer)).toHaveLength(0);
    });
  });

  it("shares its indexing rule with the category page's robots directive", () => {
    expect(categoryEarnsIndexing(0)).toBe(false);
    expect(categoryEarnsIndexing(1)).toBe(true);
  });

  it("counts and pages listings in one stable order, with no gaps or repeats", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
        await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { name });
      }

      expect(await countSitemapListings(tx, viewer)).toBe(5);

      const all = (await sitemapListings(tx, viewer)).map((e) => e.path);
      const first = (await sitemapListings(tx, viewer, { offset: 0, limit: 2 })).map((e) => e.path);
      const second = (await sitemapListings(tx, viewer, { offset: 2, limit: 2 })).map((e) => e.path);
      const third = (await sitemapListings(tx, viewer, { offset: 4, limit: 2 })).map((e) => e.path);

      expect([...first, ...second, ...third]).toEqual(all);
      expect(new Set(all).size).toBe(5);
    });
  });

  it("shards below Google's 50,000-URL ceiling", () => {
    expect(SITEMAP_SHARD_SIZE).toBe(5000);
    expect(SITEMAP_SHARD_SIZE).toBeLessThanOrEqual(50_000);
  });
});

describe("sitemap shard ids", () => {
  it("always has a static+cities and a categories shard, plus one listing shard", () => {
    expect(sitemapShardIds(0)).toEqual([STATIC_SHARD_ID, CATEGORY_SHARD_ID, "listings-0"]);
  });

  it("adds a listing shard per SITEMAP_SHARD_SIZE URLs", () => {
    expect(sitemapShardIds(SITEMAP_SHARD_SIZE)).toEqual([
      STATIC_SHARD_ID, CATEGORY_SHARD_ID, "listings-0",
    ]);
    expect(sitemapShardIds(SITEMAP_SHARD_SIZE + 1)).toEqual([
      STATIC_SHARD_ID, CATEGORY_SHARD_ID, "listings-0", "listings-1",
    ]);
    expect(sitemapShardIds(SITEMAP_SHARD_SIZE * 3)).toHaveLength(5);
  });

  it("reads a listing shard's index back, and rejects anything else", () => {
    expect(listingShardIndex("listings-0")).toBe(0);
    expect(listingShardIndex("listings-12")).toBe(12);
    for (const bad of ["listings-", "listings--1", "listings-1.5", "listings-x", "categories", "", "listings-01"]) {
      expect(listingShardIndex(bad), bad).toBeNull();
    }
  });

  it("gives every shard a distinct id", () => {
    const ids = sitemapShardIds(SITEMAP_SHARD_SIZE * 4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves every shard under the reserved /sitemaps segment", () => {
    // "sitemaps" is a reserved slug, so no city can ever claim the segment
    // these are served from.
    for (const id of sitemapShardIds(SITEMAP_SHARD_SIZE * 2)) {
      expect(shardPath(id)).toBe(`/sitemaps/sitemap/${id}.xml`);
      expect(isReserved(shardPath(id).split("/")[1] ?? "")).toBe(true);
    }
  });
});

/* ------------------------------------------------------- awards (Task 50) */

describe("sitemapAwards", () => {
  it("lists each year and each year's towns with an active winner on a published listing", async () => {
    const { sitemapAwards, AWARDS_SHARD_ID } = await import("./sitemap");
    const { computeAwardsForYear, revokeAward } = await import("./awards");
    const { ADMIN_VIEWER } = await import("@/worker/viewer");
    const { makeScaffold } = await import("@/test/factories");
    const { profiles, user, awards, listings } = await import("@/lib/db/schema");
    const { randomUUID } = await import("node:crypto");
    expect(AWARDS_SHARD_ID).toBe("awards");

    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const contest = async (c: typeof ctx) => {
        const w = await makeListing(tx, c, { ratingAvg: "4.9", ratingCount: 7 });
        await makeListing(tx, c, { ratingAvg: "4.2", ratingCount: 6 });
        await makeListing(tx, c, { ratingAvg: "3.5", ratingCount: 9 });
        return w;
      };
      await contest(ctx);
      const york = await makeCity(tx, "York", "North Yorkshire");
      const yorkWinner = await contest({ ...ctx, cityId: york });
      const { created } = await computeAwardsForYear(tx, ADMIN_VIEWER, 2031);

      const paths = (await sitemapAwards(tx, PUBLIC_VIEWER)).map((e) => e.path);
      expect(paths).toContain("/awards/2031");
      expect(paths.filter((p) => /^\/awards\/2031\/[a-z0-9-]+$/.test(p))).toHaveLength(2);

      // A revoked award and a taken-down winner both drop out.
      const userId = `u_${randomUUID()}`;
      await tx.insert(user).values({ id: userId, name: "A", email: `${userId}@example.test`, emailVerified: true });
      await tx.insert(profiles).values({ userId, role: "admin" });
      const leedsAward = created.find((c) => c.listingId !== yorkWinner)!;
      await revokeAward(tx, { role: "admin", userId }, leedsAward.awardId, { reason: "x", ip: null });
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, yorkWinner));
      expect((await sitemapAwards(tx, PUBLIC_VIEWER)).filter((e) => e.path.startsWith("/awards/2031"))).toEqual([]);
      await tx.delete(awards).where(eq(awards.year, 2031));
    });
  });
});
