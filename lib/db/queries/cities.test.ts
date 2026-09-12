import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { SWITCHER_LIMIT, listSwitcherCities, pillarHeading } from "./cities";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { cities, verticals } from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import {
  makeCity, makeScaffold, makeCategoryInCity, makeListing, type ListingCtx,
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

/**
 * The switcher is a block of crawlable links rendered on cached pages, so what
 * it may list is an indexing question, not a navigation one.
 */
describe("listSwitcherCities", () => {
  async function indexableCity(
    tx: TestDb, name: string, region: string, listingCount: number,
  ): Promise<string> {
    const id = await makeCity(tx, name, region);
    await tx.update(cities)
      .set({ isIndexable: true, listingCount, introHtml: "<p>About.</p>" })
      .where(eq(cities.id, id));
    return id;
  }

  it("lists indexable cities, busiest first, then by name", async () => {
    await withTestDb(async (tx) => {
      await indexableCity(tx, "Harrogate", "North Yorkshire", 4);
      await indexableCity(tx, "Ripon", "North Yorkshire", 9);
      await indexableCity(tx, "Askrigg", "North Yorkshire", 4);

      const rows = await listSwitcherCities(tx, PUBLIC_VIEWER);
      expect(rows.map((r) => r.name)).toEqual(["Ripon", "Askrigg", "Harrogate"]);
    });
  });

  it("never links a city we have told Google to ignore", async () => {
    await withTestDb(async (tx) => {
      await indexableCity(tx, "Ripon", "North Yorkshire", 9);
      await makeCity(tx, "Otley", "West Yorkshire");

      const rows = await listSwitcherCities(tx, PUBLIC_VIEWER);
      expect(rows.map((r) => r.name)).toEqual(["Ripon"]);
    });
  });

  it("keeps the city you are on in the list, marked, even when it is not indexable", async () => {
    await withTestDb(async (tx) => {
      await indexableCity(tx, "Ripon", "North Yorkshire", 9);
      const otley = await makeCity(tx, "Otley", "West Yorkshire");

      const rows = await listSwitcherCities(tx, PUBLIC_VIEWER, { currentCityId: otley });
      expect(rows.map((r) => r.name)).toEqual(["Ripon", "Otley"]);
      expect(rows.find((r) => r.id === otley)?.isCurrent).toBe(true);
      expect(rows.find((r) => r.name === "Ripon")?.isCurrent).toBe(false);
    });
  });

  it("lists a city once, not twice, when the one you are on is also indexable", async () => {
    await withTestDb(async (tx) => {
      const ripon = await indexableCity(tx, "Ripon", "North Yorkshire", 9);
      const rows = await listSwitcherCities(tx, PUBLIC_VIEWER, { currentCityId: ripon });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.isCurrent).toBe(true);
    });
  });

  it("never links an unpublished city, not even to an admin", async () => {
    await withTestDb(async (tx) => {
      const id = await indexableCity(tx, "Ripon", "North Yorkshire", 9);
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, id));

      expect(await listSwitcherCities(tx, PUBLIC_VIEWER, { currentCityId: id })).toEqual([]);
      // An admin gets the public answer too: this renders into the shared ISR
      // cache, so an admin-only extra link would be served to everyone.
      expect(await listSwitcherCities(tx, ADMIN, { currentCityId: id })).toEqual([]);
    });
  });

  it("accepts the city you are on as a slug, so a caller need not resolve it first", async () => {
    await withTestDb(async (tx) => {
      await indexableCity(tx, "Ripon", "North Yorkshire", 9);
      const otley = await makeCity(tx, "Otley", "West Yorkshire");

      const rows = await listSwitcherCities(tx, PUBLIC_VIEWER, { currentCitySlug: "otley" });
      expect(rows.map((r) => r.name)).toEqual(["Ripon", "Otley"]);
      expect(rows.find((r) => r.id === otley)?.isCurrent).toBe(true);
    });
  });

  it("ignores a slug that names no city we publish", async () => {
    await withTestDb(async (tx) => {
      await indexableCity(tx, "Ripon", "North Yorkshire", 9);
      const rows = await listSwitcherCities(tx, PUBLIC_VIEWER, { currentCitySlug: "nowhere" });
      expect(rows.map((r) => r.name)).toEqual(["Ripon"]);
      expect(rows.every((r) => !r.isCurrent)).toBe(true);
    });
  });

  it("caps the list in the query, at the busiest end", async () => {
    await withTestDb(async (tx) => {
      for (let n = 1; n <= 6; n++) {
        await indexableCity(tx, `City ${n}`, "North Yorkshire", n);
      }
      const rows = await listSwitcherCities(tx, PUBLIC_VIEWER, { limit: 3 });
      expect(rows.map((r) => r.name)).toEqual(["City 6", "City 5", "City 4"]);
    });
  });

  it("defaults to a bounded list rather than every city we hold", async () => {
    await withTestDb(async (tx) => {
      for (let n = 1; n <= SWITCHER_LIMIT + 3; n++) {
        await indexableCity(tx, `City ${String(n).padStart(3, "0")}`, "North Yorkshire", n);
      }
      const rows = await listSwitcherCities(tx, PUBLIC_VIEWER);
      expect(rows).toHaveLength(SWITCHER_LIMIT);
    });
  });

  it("keeps the city you are on even when the cap would have cut it", async () => {
    await withTestDb(async (tx) => {
      for (let n = 1; n <= 6; n++) {
        await indexableCity(tx, `City ${n}`, "North Yorkshire", n);
      }
      // Indexable, published, and dead last on listing count: exactly the row a
      // LIMIT drops. A switcher that cannot name where you are is broken.
      const quietest = await indexableCity(tx, "Askrigg", "North Yorkshire", 0);

      const rows = await listSwitcherCities(tx, PUBLIC_VIEWER, {
        currentCityId: quietest,
        limit: 3,
      });
      expect(rows).toHaveLength(4);
      expect(rows.at(-1)?.name).toBe("Askrigg");
      expect(rows.find((r) => r.id === quietest)?.isCurrent).toBe(true);
    });
  });
});
