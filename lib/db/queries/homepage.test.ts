import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { topCities, topCategories, featuredListings } from "./homepage";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { cities } from "@/lib/db/schema";
import { makeVertical, makeCity, makeCategoryInCity, makeListing } from "@/test/factories";

const ADMIN = { role: "admin", userId: "a" } as const;

/** A city only earns indexing; the factory default is deliberately false. */
async function indexable(tx: TestDb, id: string, count = 5) {
  await tx
    .update(cities)
    .set({ isIndexable: true, listingCount: count, introHtml: "<p>copy</p>" })
    .where(eq(cities.id, id));
}

describe("topCities", () => {
  it("never returns a non-indexable city — the homepage must not link one", async () => {
    await withTestDb(async (tx) => {
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      await makeCity(tx, "Thintown", "Nowhere");
      await indexable(tx, leeds);

      const rows = await topCities(tx, PUBLIC_VIEWER);
      expect(rows.map((r) => r.name)).toEqual(["Leeds"]);
      expect(rows.every((r) => r.isIndexable)).toBe(true);
    });
  });

  it("orders by listing count so the biggest locations lead", async () => {
    await withTestDb(async (tx) => {
      const alpha = await makeCity(tx, "Alpha", "X");
      const bravo = await makeCity(tx, "Bravo", "Y");
      await indexable(tx, alpha, 2);
      await indexable(tx, bravo, 40);

      expect((await topCities(tx, PUBLIC_VIEWER)).map((r) => r.name)).toEqual([
        "Bravo",
        "Alpha",
      ]);
    });
  });

  it("caps the block at the requested limit", async () => {
    await withTestDb(async (tx) => {
      for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
        await indexable(tx, await makeCity(tx, name, "X"));
      }
      expect(await topCities(tx, PUBLIC_VIEWER, 2)).toHaveLength(2);
    });
  });

  it("shows thin cities to an admin", async () => {
    await withTestDb(async (tx) => {
      await makeCity(tx, "Thintown", "Nowhere");
      expect(await topCities(tx, ADMIN)).toHaveLength(1);
    });
  });
});

describe("topCategories", () => {
  it("omits a type with no listings, so the homepage never links an empty page", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const used = await makeCategoryInCity(tx, v, city, "Barn Venues");
      await makeCategoryInCity(tx, v, city, "Empty Type");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: used });

      expect((await topCategories(tx, PUBLIC_VIEWER)).map((c) => c.name)).toEqual([
        "Barn Venues",
      ]);
    });
  });

  it("does not let an unpublished listing keep a type on the homepage", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Venues");
      await makeListing(
        tx,
        { cityId: city, verticalId: v, primaryCategoryId: cat },
        { status: "pending" },
      );

      expect(await topCategories(tx, PUBLIC_VIEWER)).toEqual([]);
    });
  });

  it("caps the block at the requested limit", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      for (const name of ["Type A", "Type B", "Type C"]) {
        const cat = await makeCategoryInCity(tx, v, city, name);
        await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat });
      }
      expect(await topCategories(tx, PUBLIC_VIEWER, 2)).toHaveLength(2);
    });
  });
});

describe("featuredListings", () => {
  it("returns nothing when no premium listing exists — the row is then not rendered", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city);
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat });
      await makeListing(
        tx,
        { cityId: city, verticalId: v, primaryCategoryId: cat },
        { tier: "essential" },
      );

      expect(await featuredListings(tx, PUBLIC_VIEWER)).toEqual([]);
    });
  });

  it("returns premium listings only", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city);
      await makeListing(
        tx,
        { cityId: city, verticalId: v, primaryCategoryId: cat },
        { name: "Paid", tier: "premium" },
      );
      await makeListing(
        tx,
        { cityId: city, verticalId: v, primaryCategoryId: cat },
        { name: "Unpaid", tier: "free" },
      );

      const rows = await featuredListings(tx, PUBLIC_VIEWER);
      expect(rows.map((r) => r.name)).toEqual(["Paid"]);
    });
  });

  it("hides an unpublished premium listing from the public", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city);
      await makeListing(
        tx,
        { cityId: city, verticalId: v, primaryCategoryId: cat },
        { name: "Pending Paid", tier: "premium", status: "pending" },
      );
      await makeListing(
        tx,
        { cityId: city, verticalId: v, primaryCategoryId: cat },
        { name: "Removed Paid", tier: "premium", status: "removed" },
      );

      expect(await featuredListings(tx, PUBLIC_VIEWER)).toEqual([]);
      expect(await featuredListings(tx, ADMIN)).toHaveLength(2);
    });
  });

  it("carries the city slug needed to build the listing URL", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, city);
      await makeListing(
        tx,
        { cityId: city, verticalId: v, primaryCategoryId: cat },
        { name: "Paid", tier: "premium" },
      );

      const [row] = await featuredListings(tx, PUBLIC_VIEWER);
      expect(row?.cityName).toBe("Leeds");
      expect(row?.citySlug).toBe("leeds");
    });
  });

  it("caps the row at six by default", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city);
      for (let i = 0; i < 9; i++) {
        await makeListing(
          tx,
          { cityId: city, verticalId: v, primaryCategoryId: cat },
          { name: `Paid ${i}`, tier: "premium" },
        );
      }
      expect(await featuredListings(tx, PUBLIC_VIEWER)).toHaveLength(6);
    });
  });
});
