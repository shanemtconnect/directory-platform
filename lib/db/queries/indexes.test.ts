import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { listCities, listCategories, categoriesInCity, nearbyCities } from "./indexes";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { cities } from "@/lib/db/schema";
import { makeVertical, makeCity, makeCategoryInCity, makeListing } from "@/test/factories";

const ADMIN = { role: "admin", userId: "a" } as const;

async function indexable(tx: TestDb, id: string, count = 5) {
  await tx.update(cities)
    .set({ isIndexable: true, listingCount: count, introHtml: "<p>copy</p>" })
    .where(eq(cities.id, id));
}

describe("listCities", () => {
  it("hides non-indexable cities from the public — the footer must never link one", async () => {
    await withTestDb(async (tx) => {
      const a = await makeCity(tx, "Leeds", "West Yorkshire");
      await makeCity(tx, "Thintown", "Nowhere");
      await indexable(tx, a);
      const rows = await listCities(tx, PUBLIC_VIEWER);
      expect(rows.map((r) => r.name)).toEqual(["Leeds"]);
    });
  });

  it("shows every city to an admin, including the thin ones", async () => {
    await withTestDb(async (tx) => {
      await makeCity(tx, "Leeds", "West Yorkshire");
      await makeCity(tx, "Thintown", "Nowhere");
      expect(await listCities(tx, ADMIN)).toHaveLength(2);
    });
  });

  it("orders by listing count, then alphabetically", async () => {
    await withTestDb(async (tx) => {
      const a = await makeCity(tx, "Alpha", "X");
      const b = await makeCity(tx, "Bravo", "Y");
      const c = await makeCity(tx, "Charlie", "Z");
      await indexable(tx, a, 2); await indexable(tx, b, 9); await indexable(tx, c, 2);
      expect((await listCities(tx, PUBLIC_VIEWER)).map((r) => r.name))
        .toEqual(["Bravo", "Alpha", "Charlie"]);
    });
  });
});

describe("listCategories", () => {
  it("omits a category with no published listings", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const used = await makeCategoryInCity(tx, v, city, "Barn Venues");
      await makeCategoryInCity(tx, v, city, "Empty Type");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: used });
      expect((await listCategories(tx, PUBLIC_VIEWER)).map((c) => c.name)).toEqual(["Barn Venues"]);
    });
  });

  it("does not count unpublished listings toward a category", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Venues");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { status: "pending" });
      expect(await listCategories(tx, PUBLIC_VIEWER)).toHaveLength(0);
    });
  });
});

describe("categoriesInCity", () => {
  it("returns only categories that actually have listings in that city", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      const bristol = await makeCity(tx, "Bristol", "Bristol");
      const barns = await makeCategoryInCity(tx, v, leeds, "Barn Venues");
      const halls = await makeCategoryInCity(tx, v, bristol, "Historic Halls");
      await makeListing(tx, { cityId: leeds, verticalId: v, primaryCategoryId: barns });
      await makeListing(tx, { cityId: bristol, verticalId: v, primaryCategoryId: halls });
      expect((await categoriesInCity(tx, PUBLIC_VIEWER, leeds)).map((c) => c.name))
        .toEqual(["Barn Venues"]);
    });
  });
});

describe("nearbyCities", () => {
  it("orders by real distance, not alphabetically", async () => {
    await withTestDb(async (tx) => {
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      const bradford = await makeCity(tx, "Bradford", "West Yorkshire");
      const plymouth = await makeCity(tx, "Plymouth", "Devon");
      await tx.update(cities).set({ lat: 53.8008, lng: -1.5491 }).where(eq(cities.id, leeds));
      await tx.update(cities).set({ lat: 53.7960, lng: -1.7594 }).where(eq(cities.id, bradford));
      await tx.update(cities).set({ lat: 50.3755, lng: -4.1427 }).where(eq(cities.id, plymouth));
      await indexable(tx, bradford); await indexable(tx, plymouth);

      // Bradford is ~14km from Leeds; Plymouth ~450km. Alphabetically Bradford
      // also comes first, so give Plymouth a name that sorts earlier to prove
      // it is distance doing the work.
      const rows = await nearbyCities(tx, leeds, 2);
      expect(rows[0]?.name).toBe("Bradford");
      expect(rows[1]?.name).toBe("Plymouth");
    });
  });

  it("excludes the origin city itself", async () => {
    await withTestDb(async (tx) => {
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      await tx.update(cities).set({ lat: 53.8, lng: -1.54 }).where(eq(cities.id, leeds));
      await indexable(tx, leeds);
      expect((await nearbyCities(tx, leeds)).map((r) => r.id)).not.toContain(leeds);
    });
  });

  it("never returns a non-indexable city", async () => {
    await withTestDb(async (tx) => {
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      const thin = await makeCity(tx, "Thintown", "Nowhere");
      await tx.update(cities).set({ lat: 53.8, lng: -1.54 }).where(eq(cities.id, leeds));
      await tx.update(cities).set({ lat: 53.81, lng: -1.55 }).where(eq(cities.id, thin));
      expect(await nearbyCities(tx, leeds)).toHaveLength(0);
    });
  });

  it("returns nothing when the origin has no coordinates", async () => {
    await withTestDb(async (tx) => {
      const nowhere = await makeCity(tx, "Nocoords", "X");
      expect(await nearbyCities(tx, nowhere)).toEqual([]);
    });
  });
});

describe("categoriesInCity — per-city slug", () => {
  it("returns the city-scoped slug, not the national one", async () => {
    await withTestDb(async (tx) => {
      const { allocateSlug, ROOT_SCOPE } = await import("@/lib/routing/slugs");
      const { randomUUID } = await import("node:crypto");
      const { categories: cats, listings: ls } = await import("@/lib/db/schema");

      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");

      // Occupy "barn-venues" in this city with something else, forcing the
      // category's per-city slug to be disambiguated.
      await allocateSlug(tx, {
        parentScope: city, desired: "Barn Venues", kind: "listing", entityId: randomUUID(),
      });

      const catId = randomUUID();
      const nationalSlug = await allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Barn Venues", kind: "category", entityId: catId,
      });
      await tx.insert(cats).values({
        id: catId, verticalId: v, name: "Barn Venues", slug: nationalSlug,
        singular: "barn venue", plural: "barn venues",
      });
      const cityScoped = await allocateSlug(tx, {
        parentScope: city, desired: "Barn Venues", kind: "category", entityId: catId,
      });
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: catId });

      expect(nationalSlug).toBe("barn-venues");
      expect(cityScoped).not.toBe("barn-venues");

      const rows = await categoriesInCity(tx, PUBLIC_VIEWER, city);
      // Linking the national slug here would be a hard 404.
      expect(rows[0]?.slug).toBe(cityScoped);
    });
  });

  it("drops a category that has listings but was never routed in this city", async () => {
    await withTestDb(async (tx) => {
      const { allocateSlug, ROOT_SCOPE } = await import("@/lib/routing/slugs");
      const { randomUUID } = await import("node:crypto");
      const { categories: cats } = await import("@/lib/db/schema");

      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const catId = randomUUID();
      const nationalSlug = await allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Orphan Type", kind: "category", entityId: catId,
      });
      await tx.insert(cats).values({
        id: catId, verticalId: v, name: "Orphan Type", slug: nationalSlug,
        singular: "orphan", plural: "orphans",
      });
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: catId });

      // No per-city slug allocated, so no route exists — must not be linked.
      expect(await categoriesInCity(tx, PUBLIC_VIEWER, city)).toHaveLength(0);
    });
  });
});
