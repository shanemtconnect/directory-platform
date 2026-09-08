import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { cities, categories } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import {
  getCategoryBySlug,
  listCategoryListings,
  countCategoryListings,
  citiesForCategory,
} from "./category-page";
import {
  makeVertical,
  makeCity,
  makeCategory,
  makeCategoryInCity,
  linkCategoryToCity,
  makeListing,
} from "@/test/factories";

const ADMIN = { role: "admin", userId: "a" } as const;

/** A city only earns links once it is indexable — see the crawl-budget rule. */
async function indexable(tx: TestDb, id: string, count = 5) {
  await tx
    .update(cities)
    .set({ isIndexable: true, listingCount: count, introHtml: "<p>copy</p>" })
    .where(eq(cities.id, id));
}

describe("getCategoryBySlug", () => {
  it("finds a category by its national slug", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const id = await makeCategory(tx, v, "Barn Halls");
      const row = await getCategoryBySlug(tx, PUBLIC_VIEWER, "barn-halls");
      expect(row?.id).toBe(id);
      expect(row?.name).toBe("Barn Halls");
    });
  });

  it("is case-insensitive on the slug", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      await makeCategory(tx, v, "Barn Halls");
      expect(await getCategoryBySlug(tx, PUBLIC_VIEWER, "BARN-HALLS")).not.toBeNull();
    });
  });

  it("returns null for an unknown slug", async () => {
    await withTestDb(async (tx) => {
      expect(await getCategoryBySlug(tx, PUBLIC_VIEWER, "no-such-thing")).toBeNull();
    });
  });

  it("hides an inactive category from the public but not from an admin", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const id = await makeCategory(tx, v, "Retired Type");
      await tx.update(categories).set({ isActive: false }).where(eq(categories.id, id));

      expect(await getCategoryBySlug(tx, PUBLIC_VIEWER, "retired-type")).toBeNull();
      expect((await getCategoryBySlug(tx, ADMIN, "retired-type"))?.id).toBe(id);
    });
  });
});

describe("listCategoryListings", () => {
  it("gathers the category across every city, not just one", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      const bristol = await makeCity(tx, "Bristol", "Bristol");
      const cat = await makeCategoryInCity(tx, v, leeds, "Barn Halls");
      await linkCategoryToCity(tx, cat, bristol, "Barn Halls");

      await makeListing(tx, { cityId: leeds, verticalId: v, primaryCategoryId: cat }, { name: "North One" });
      await makeListing(tx, { cityId: bristol, verticalId: v, primaryCategoryId: cat }, { name: "South One" });

      const rows = await listCategoryListings(tx, PUBLIC_VIEWER, cat);
      expect(rows.map((r) => r.listing.name).sort()).toEqual(["North One", "South One"]);
      expect(rows.map((r) => r.citySlug).sort()).toEqual(["bristol", "leeds"]);
    });
  });

  it("never shows an unpublished listing to the public, but shows it to an admin", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      const ctx = { cityId: city, verticalId: v, primaryCategoryId: cat };

      await makeListing(tx, ctx, { name: "Live One" });
      await makeListing(tx, ctx, { name: "Pending One", status: "pending" });
      await makeListing(tx, ctx, { name: "Draft One", status: "draft" });
      await makeListing(tx, ctx, { name: "Rejected One", status: "rejected" });

      expect((await listCategoryListings(tx, PUBLIC_VIEWER, cat)).map((r) => r.listing.name))
        .toEqual(["Live One"]);
      expect(await listCategoryListings(tx, ADMIN, cat)).toHaveLength(4);
    });
  });

  it("excludes listings whose primary category is a different one", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const wanted = await makeCategoryInCity(tx, v, city, "Barn Halls");
      const other = await makeCategoryInCity(tx, v, city, "Historic Halls");

      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: wanted }, { name: "Keep" });
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: other }, { name: "Drop" });

      expect((await listCategoryListings(tx, PUBLIC_VIEWER, wanted)).map((r) => r.listing.name))
        .toEqual(["Keep"]);
    });
  });

  it("paginates 24 per page with no overlap and no gap", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      const ctx = { cityId: city, verticalId: v, primaryCategoryId: cat };
      for (let i = 0; i < 30; i++) {
        await makeListing(tx, ctx, { name: `Listing ${String(i).padStart(2, "0")}` });
      }

      const one = await listCategoryListings(tx, PUBLIC_VIEWER, cat, { page: 1 });
      const two = await listCategoryListings(tx, PUBLIC_VIEWER, cat, { page: 2 });

      expect(one).toHaveLength(24);
      expect(two).toHaveLength(6);

      const ids = new Set([...one, ...two].map((r) => r.listing.id));
      expect(ids.size).toBe(30);
      expect(await countCategoryListings(tx, PUBLIC_VIEWER, cat)).toBe(30);
    });
  });

  it("clamps a page below 1 to page 1 rather than sending a negative offset", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { name: "Only" });

      expect((await listCategoryListings(tx, PUBLIC_VIEWER, cat, { page: 0 })).map((r) => r.listing.name))
        .toEqual(["Only"]);
      expect((await listCategoryListings(tx, PUBLIC_VIEWER, cat, { page: -3 })).map((r) => r.listing.name))
        .toEqual(["Only"]);
    });
  });

  it("ranks a paid tier above a free one", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      const ctx = { cityId: city, verticalId: v, primaryCategoryId: cat };
      await makeListing(tx, ctx, { name: "Free One", tier: "free" });
      await makeListing(tx, ctx, { name: "Paid One", tier: "premium" });

      const rows = await listCategoryListings(tx, PUBLIC_VIEWER, cat);
      expect(rows[0]?.listing.name).toBe("Paid One");
    });
  });
});

describe("countCategoryListings", () => {
  it("counts only published listings for the public", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      const ctx = { cityId: city, verticalId: v, primaryCategoryId: cat };
      await makeListing(tx, ctx);
      await makeListing(tx, ctx, { status: "pending" });

      expect(await countCategoryListings(tx, PUBLIC_VIEWER, cat)).toBe(1);
      expect(await countCategoryListings(tx, ADMIN, cat)).toBe(2);
    });
  });

  it("returns 0 for a category whose only listings are unpublished — this is what drives noindex", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx);
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { status: "pending" });

      expect(await countCategoryListings(tx, PUBLIC_VIEWER, cat)).toBe(0);
    });
  });
});

describe("citiesForCategory", () => {
  it("never returns a non-indexable city — the crawl-budget rule", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      const thin = await makeCity(tx, "Thintown", "Nowhere");
      const cat = await makeCategoryInCity(tx, v, leeds, "Barn Halls");
      await linkCategoryToCity(tx, cat, thin, "Barn Halls");
      await indexable(tx, leeds);

      await makeListing(tx, { cityId: leeds, verticalId: v, primaryCategoryId: cat });
      await makeListing(tx, { cityId: thin, verticalId: v, primaryCategoryId: cat });

      const rows = await citiesForCategory(tx, PUBLIC_VIEWER, cat);
      expect(rows.map((r) => r.name)).toEqual(["Leeds"]);
    });
  });

  it("shows a non-indexable city to an admin", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const thin = await makeCity(tx, "Thintown", "Nowhere");
      const cat = await makeCategoryInCity(tx, v, thin, "Barn Halls");
      await makeListing(tx, { cityId: thin, verticalId: v, primaryCategoryId: cat });

      expect((await citiesForCategory(tx, ADMIN, cat)).map((r) => r.name)).toEqual(["Thintown"]);
    });
  });

  it("excludes an unpublished city even from an admin", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const hidden = await makeCity(tx, "Hidden", "Nowhere");
      const cat = await makeCategoryInCity(tx, v, hidden, "Barn Halls");
      await makeListing(tx, { cityId: hidden, verticalId: v, primaryCategoryId: cat });
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, hidden));

      expect(await citiesForCategory(tx, ADMIN, cat)).toEqual([]);
    });
  });

  it("skips a city where the category was never routed — that link would 404", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      const bristol = await makeCity(tx, "Bristol", "Bristol");
      const cat = await makeCategoryInCity(tx, v, leeds, "Barn Halls");
      await indexable(tx, leeds);
      await indexable(tx, bristol);

      await makeListing(tx, { cityId: leeds, verticalId: v, primaryCategoryId: cat });
      // Bristol has a listing in the category but no /bristol/barn-halls route.
      await makeListing(tx, { cityId: bristol, verticalId: v, primaryCategoryId: cat });

      expect((await citiesForCategory(tx, PUBLIC_VIEWER, cat)).map((r) => r.name)).toEqual(["Leeds"]);
    });
  });

  it("returns the city-scoped category slug, not the national one", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategory(tx, v, "Barn Halls");
      // Something else already owns /leeds/barn-halls, so the city-scoped slug
      // is disambiguated and the national slug would be a dead link.
      const other = await makeCategory(tx, v, "Barn Halls Annex");
      await linkCategoryToCity(tx, other, leeds, "Barn Halls");
      const scoped = await linkCategoryToCity(tx, cat, leeds, "Barn Halls");
      await indexable(tx, leeds);
      await makeListing(tx, { cityId: leeds, verticalId: v, primaryCategoryId: cat });

      expect(scoped).not.toBe("barn-halls");
      expect((await citiesForCategory(tx, PUBLIC_VIEWER, cat))[0]?.categorySlug).toBe(scoped);
    });
  });

  it("counts only this category's published listings per city", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, leeds, "Barn Halls");
      const other = await makeCategoryInCity(tx, v, leeds, "Historic Halls");
      await indexable(tx, leeds, 99);
      const ctx = { cityId: leeds, verticalId: v, primaryCategoryId: cat };

      await makeListing(tx, ctx);
      await makeListing(tx, ctx);
      await makeListing(tx, ctx, { status: "pending" });
      await makeListing(tx, { cityId: leeds, verticalId: v, primaryCategoryId: other });

      const rows = await citiesForCategory(tx, PUBLIC_VIEWER, cat);
      expect(rows[0]?.listingCount).toBe(2);
    });
  });

  it("orders by listing count, then alphabetically", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const alpha = await makeCity(tx, "Alpha", "X");
      const bravo = await makeCity(tx, "Bravo", "Y");
      const charlie = await makeCity(tx, "Charlie", "Z");
      const cat = await makeCategoryInCity(tx, v, alpha, "Barn Halls");
      await linkCategoryToCity(tx, cat, bravo, "Barn Halls");
      await linkCategoryToCity(tx, cat, charlie, "Barn Halls");
      for (const id of [alpha, bravo, charlie]) await indexable(tx, id);

      await makeListing(tx, { cityId: alpha, verticalId: v, primaryCategoryId: cat });
      await makeListing(tx, { cityId: charlie, verticalId: v, primaryCategoryId: cat });
      for (let i = 0; i < 3; i++) {
        await makeListing(tx, { cityId: bravo, verticalId: v, primaryCategoryId: cat });
      }

      expect((await citiesForCategory(tx, PUBLIC_VIEWER, cat)).map((r) => r.name))
        .toEqual(["Bravo", "Alpha", "Charlie"]);
    });
  });

  it("returns nothing for a category with no published listings anywhere", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, leeds, "Barn Halls");
      await indexable(tx, leeds);
      await makeListing(tx, { cityId: leeds, verticalId: v, primaryCategoryId: cat }, { status: "draft" });

      expect(await citiesForCategory(tx, PUBLIC_VIEWER, cat)).toEqual([]);
    });
  });
});
