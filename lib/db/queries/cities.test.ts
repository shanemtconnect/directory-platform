import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { pillarHeading } from "./cities";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { cities, verticals } from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import {
  makeScaffold, makeCategoryInCity, makeListing, type ListingCtx,
} from "@/test/factories";

const ADMIN = { role: "admin", userId: "a" } as const;
const MIN = siteConfig.seo.minListingsToIndex;
const PLURAL = siteConfig.entity;

async function addListings(tx: TestDb, ctx: ListingCtx, n: number) {
  for (let i = 0; i < n; i++) await makeListing(tx, ctx, { name: `Listing ${i}` });
}

describe("pillarHeading — the indexing gate is never bypassed", () => {
  it("does not hand a vertical page indexing it has not earned", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(verticals).set({ introHtml: "<p>About us.</p>" })
        .where(eq(verticals.id, ctx.verticalId));

      const heading = await pillarHeading(
        tx, PUBLIC_VIEWER, { type: "vertical", verticalId: ctx.verticalId }, PLURAL,
      );
      expect(heading?.isIndexable).toBe(false);
      expect(heading?.listingCount).toBe(0);
    });
  });

  it("reports the vertical page's real count once it has listings", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(verticals).set({ introHtml: "<p>About us.</p>" })
        .where(eq(verticals.id, ctx.verticalId));
      await addListings(tx, ctx, MIN);

      const heading = await pillarHeading(
        tx, PUBLIC_VIEWER, { type: "vertical", verticalId: ctx.verticalId }, PLURAL,
      );
      expect(heading).toMatchObject({ listingCount: MIN, isIndexable: true });
    });
  });

  it("judges a city-category page on its own count, not the city's", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(cities)
        .set({ introHtml: "<p>About this town.</p>", isIndexable: true, listingCount: 99 })
        .where(eq(cities.id, ctx.cityId));
      await addListings(tx, ctx, MIN);
      const thinCategoryId = await makeCategoryInCity(
        tx, ctx.verticalId, ctx.cityId, "Hotel Rooms",
      );
      await makeListing(tx, { ...ctx, primaryCategoryId: thinCategoryId }, { name: "Only one" });

      const heading = await pillarHeading(tx, PUBLIC_VIEWER, {
        type: "city-category", cityId: ctx.cityId, categoryId: thinCategoryId,
      }, PLURAL);
      expect(heading).toMatchObject({ listingCount: 1, isIndexable: false });
    });
  });

  it("reads the flag live rather than trusting a stale cities row", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(cities)
        .set({ isIndexable: true, listingCount: 99 })
        .where(eq(cities.id, ctx.cityId));

      const heading = await pillarHeading(
        tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId }, PLURAL,
      );
      expect(heading).toMatchObject({ listingCount: 0, isIndexable: false });
    });
  });

  it("returns null for an unpublished city — that page is not live", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, ctx.cityId));
      expect(await pillarHeading(
        tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId }, PLURAL,
      )).toBeNull();
    });
  });

  it("still renders an unpublished city for an admin preview", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, ctx.cityId));
      const heading = await pillarHeading(
        tx, ADMIN, { type: "city", cityId: ctx.cityId }, PLURAL,
      );
      expect(heading?.place).toBe("Leeds");
      expect(heading?.isIndexable).toBe(false);
    });
  });

  it("returns null for an inactive vertical", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(verticals).set({ isActive: false })
        .where(eq(verticals.id, ctx.verticalId));
      expect(await pillarHeading(
        tx, PUBLIC_VIEWER, { type: "vertical", verticalId: ctx.verticalId }, PLURAL,
      )).toBeNull();
    });
  });

  it("still builds the heading from entity nouns, never a hardcoded one", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const heading = await pillarHeading(
        tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId }, PLURAL,
      );
      expect(heading?.title).toBe(`${PLURAL.Plural} in Leeds`);
    });
  });
});
