import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { withTestDb, type TestDb } from "@/test/db";
import { recomputeCityIndexability, scopeIndexability } from "./indexing";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { cities, areas, verticals, categories } from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import {
  makeCity, makeVertical, makeCategoryInCity, makeListing, makeScaffold,
  type ListingCtx,
} from "@/test/factories";

const ADMIN = { role: "admin", userId: "a" } as const;
const MIN = siteConfig.seo.minListingsToIndex;

async function withIntro(tx: TestDb, cityId: string) {
  await tx.update(cities).set({ introHtml: "<p>About this town.</p>" })
    .where(eq(cities.id, cityId));
}

async function makeArea(tx: TestDb, name = "Riverside"): Promise<string> {
  const id = randomUUID();
  await tx.insert(areas).values({
    id, name, slug: `${name.toLowerCase()}-${id.slice(0, 8)}`,
    introHtml: "<p>About this area.</p>",
  });
  return id;
}

async function addListings(tx: TestDb, ctx: ListingCtx, n: number) {
  for (let i = 0; i < n; i++) await makeListing(tx, ctx, { name: `Listing ${i}` });
}

describe("recomputeCityIndexability", () => {
  it("keeps the gate shut one listing below the threshold", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await withIntro(tx, ctx.cityId);
      await addListings(tx, ctx, MIN - 1);

      const out = await recomputeCityIndexability(tx, ADMIN, ctx.cityId);
      expect(out).toEqual({ listingCount: MIN - 1, isIndexable: false });
    });
  });

  it("opens the gate at exactly the configured threshold", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await withIntro(tx, ctx.cityId);
      await addListings(tx, ctx, MIN);

      expect(await recomputeCityIndexability(tx, ADMIN, ctx.cityId))
        .toEqual({ listingCount: MIN, isIndexable: true });
    });
  });

  it("keeps the gate shut without intro copy, however many listings there are", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await addListings(tx, ctx, MIN + 5);

      expect(await recomputeCityIndexability(tx, ADMIN, ctx.cityId))
        .toEqual({ listingCount: MIN + 5, isIndexable: false });
    });
  });

  it("treats whitespace-only intro copy as no intro copy", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(cities).set({ introHtml: "   " }).where(eq(cities.id, ctx.cityId));
      await addListings(tx, ctx, MIN);

      expect((await recomputeCityIndexability(tx, ADMIN, ctx.cityId))?.isIndexable).toBe(false);
    });
  });

  it("counts published listings only — a pending queue never opens the gate", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await withIntro(tx, ctx.cityId);
      await addListings(tx, ctx, MIN - 1);
      await makeListing(tx, ctx, { name: "Waiting", status: "pending" });

      expect(await recomputeCityIndexability(tx, ADMIN, ctx.cityId))
        .toEqual({ listingCount: MIN - 1, isIndexable: false });
    });
  });

  it("writes both the count and the flag back to the city row", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await withIntro(tx, ctx.cityId);
      await addListings(tx, ctx, MIN);
      await recomputeCityIndexability(tx, ADMIN, ctx.cityId);

      const [row] = await tx.select().from(cities).where(eq(cities.id, ctx.cityId));
      expect(row?.listingCount).toBe(MIN);
      expect(row?.isIndexable).toBe(true);
    });
  });

  it("closes a gate that has already opened when listings go away", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await withIntro(tx, ctx.cityId);
      await tx.update(cities).set({ isIndexable: true, listingCount: 99 })
        .where(eq(cities.id, ctx.cityId));

      expect(await recomputeCityIndexability(tx, ADMIN, ctx.cityId))
        .toEqual({ listingCount: 0, isIndexable: false });
      const [row] = await tx.select().from(cities).where(eq(cities.id, ctx.cityId));
      expect(row?.isIndexable).toBe(false);
    });
  });

  it("returns null for a city that does not exist", async () => {
    await withTestDb(async (tx) => {
      expect(await recomputeCityIndexability(
        tx, ADMIN, "00000000-0000-0000-0000-000000000000",
      )).toBeNull();
    });
  });
});

describe("scopeIndexability", () => {
  it("computes a city scope from that city's own published count", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await withIntro(tx, ctx.cityId);
      await addListings(tx, ctx, MIN);

      expect(await scopeIndexability(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId }))
        .toEqual({ listingCount: MIN, isIndexable: true });
    });
  });

  it("computes a city-category scope from the category's count, not the city's", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await withIntro(tx, ctx.cityId);
      await addListings(tx, ctx, MIN);
      const otherCategoryId = await makeCategoryInCity(
        tx, ctx.verticalId, ctx.cityId, "Hotel Rooms",
      );
      await makeListing(tx, { ...ctx, primaryCategoryId: otherCategoryId }, { name: "Only one" });

      expect(await scopeIndexability(tx, PUBLIC_VIEWER, {
        type: "city-category", cityId: ctx.cityId, categoryId: otherCategoryId,
      })).toEqual({ listingCount: 1, isIndexable: false });
    });
  });

  it("never hands a vertical scope a free pass", async () => {
    await withTestDb(async (tx) => {
      const verticalId = await makeVertical(tx);
      const cityId = await makeCity(tx);
      const primaryCategoryId = await makeCategoryInCity(tx, verticalId, cityId);
      await tx.update(verticals).set({ introHtml: "<p>About us.</p>" })
        .where(eq(verticals.id, verticalId));
      await addListings(tx, { cityId, verticalId, primaryCategoryId }, MIN - 1);

      expect(await scopeIndexability(tx, PUBLIC_VIEWER, { type: "vertical", verticalId }))
        .toEqual({ listingCount: MIN - 1, isIndexable: false });
    });
  });

  it("opens a vertical scope once it has earned it", async () => {
    await withTestDb(async (tx) => {
      const verticalId = await makeVertical(tx);
      const cityId = await makeCity(tx);
      const primaryCategoryId = await makeCategoryInCity(tx, verticalId, cityId);
      await tx.update(verticals).set({ introHtml: "<p>About us.</p>" })
        .where(eq(verticals.id, verticalId));
      await addListings(tx, { cityId, verticalId, primaryCategoryId }, MIN);

      expect(await scopeIndexability(tx, PUBLIC_VIEWER, { type: "vertical", verticalId }))
        .toEqual({ listingCount: MIN, isIndexable: true });
    });
  });

  it("computes an area scope from the area's own count and intro copy", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const areaId = await makeArea(tx);
      for (let i = 0; i < MIN; i++) {
        await makeListing(tx, ctx, { name: `Area listing ${i}`, areaId });
      }

      expect(await scopeIndexability(tx, PUBLIC_VIEWER, {
        type: "vertical-area", verticalId: ctx.verticalId, areaId,
      })).toEqual({ listingCount: MIN, isIndexable: true });
    });
  });

  it("returns null for an unpublished city", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, ctx.cityId));
      expect(await scopeIndexability(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId }))
        .toBeNull();
    });
  });

  it("returns null for an inactive category on a city-category scope", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(categories).set({ isActive: false })
        .where(eq(categories.id, ctx.primaryCategoryId));
      expect(await scopeIndexability(tx, PUBLIC_VIEWER, {
        type: "city-category", cityId: ctx.cityId, categoryId: ctx.primaryCategoryId,
      })).toBeNull();
    });
  });

  it("returns null for an inactive vertical", async () => {
    await withTestDb(async (tx) => {
      const verticalId = await makeVertical(tx);
      await tx.update(verticals).set({ isActive: false }).where(eq(verticals.id, verticalId));
      expect(await scopeIndexability(tx, PUBLIC_VIEWER, { type: "vertical", verticalId }))
        .toBeNull();
    });
  });

  it("returns null for an unpublished area", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const areaId = await makeArea(tx);
      await tx.update(areas).set({ isPublished: false }).where(eq(areas.id, areaId));
      expect(await scopeIndexability(tx, PUBLIC_VIEWER, {
        type: "vertical-area", verticalId: ctx.verticalId, areaId,
      })).toBeNull();
    });
  });

  it("still answers for an admin previewing an unpublished city", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, ctx.cityId));
      expect(await scopeIndexability(tx, ADMIN, { type: "city", cityId: ctx.cityId }))
        .toEqual({ listingCount: 0, isIndexable: false });
    });
  });

  it("returns null for a scope whose entity does not exist", async () => {
    await withTestDb(async (tx) => {
      expect(await scopeIndexability(tx, ADMIN, {
        type: "city", cityId: "00000000-0000-0000-0000-000000000000",
      })).toBeNull();
    });
  });
});
