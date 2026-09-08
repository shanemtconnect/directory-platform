import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { withTestDb, type TestDb } from "@/test/db";
import * as schema from "@/lib/db/schema";
import { getFooterMatrix } from "./footer";
import { sitemapCities } from "./sitemap";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { cities } from "@/lib/db/schema";
import {
  makeVertical, makeCity, makeCategory, makeCategoryInCity,
  linkCategoryToCity, makeListing,
} from "@/test/factories";

const ADMIN = { role: "admin", userId: "a" } as const;

async function indexable(tx: TestDb, id: string, count = 5) {
  await tx.update(cities)
    .set({ isIndexable: true, listingCount: count, introHtml: "<p>copy</p>" })
    .where(eq(cities.id, id));
}

/** Flattens the matrix to the hrefs it would actually render. */
function hrefs(blocks: Awaited<ReturnType<typeof getFooterMatrix>>): string[] {
  return blocks.flatMap((b) => b.cities.map((c) => c.href));
}

describe("getFooterMatrix — indexability", () => {
  it("never links a non-indexable city", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const good = await makeCity(tx, "Leeds", "West Yorkshire");
      const thin = await makeCity(tx, "Thintown", "Nowhere");
      const cat = await makeCategory(tx, v, "Barn Halls");
      await linkCategoryToCity(tx, cat, good, "Barn Halls");
      await linkCategoryToCity(tx, cat, thin, "Barn Halls");
      await makeListing(tx, { cityId: good, verticalId: v, primaryCategoryId: cat });
      await makeListing(tx, { cityId: thin, verticalId: v, primaryCategoryId: cat });
      await indexable(tx, good);

      expect(hrefs(await getFooterMatrix(tx, PUBLIC_VIEWER))).toEqual(["/leeds/barn-halls"]);
    });
  });

  it("does not link a non-indexable city even for an admin — the shell is a shared ISR cache", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const thin = await makeCity(tx, "Thintown", "Nowhere");
      const cat = await makeCategoryInCity(tx, v, thin, "Barn Halls");
      await makeListing(tx, { cityId: thin, verticalId: v, primaryCategoryId: cat });

      expect(await getFooterMatrix(tx, ADMIN)).toEqual([]);
    });
  });

  it("does not link an unpublished city", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat });
      await indexable(tx, city);
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, city));

      expect(await getFooterMatrix(tx, PUBLIC_VIEWER)).toEqual([]);
    });
  });

  it("links only cities the sitemap also lists — one indexing gate, not two", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const good = await makeCity(tx, "Leeds", "West Yorkshire");
      const thin = await makeCity(tx, "Thintown", "Nowhere");
      const cat = await makeCategory(tx, v, "Barn Halls");
      await linkCategoryToCity(tx, cat, good, "Barn Halls");
      await linkCategoryToCity(tx, cat, thin, "Barn Halls");
      await makeListing(tx, { cityId: good, verticalId: v, primaryCategoryId: cat });
      await makeListing(tx, { cityId: thin, verticalId: v, primaryCategoryId: cat });
      await indexable(tx, good);

      const allowed = new Set((await sitemapCities(tx, PUBLIC_VIEWER)).map((e) => e.path));
      const linkedCities = hrefs(await getFooterMatrix(tx, PUBLIC_VIEWER))
        .map((h) => `/${h.split("/")[1]}`);

      expect(linkedCities.length).toBeGreaterThan(0);
      for (const path of linkedCities) expect(allowed.has(path)).toBe(true);
    });
  });
});

describe("getFooterMatrix — city-scoped slugs", () => {
  it("uses the city-scoped slug, not categories.slug, when the two collide", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const decoy = await makeCategoryInCity(tx, v, city, "Hotels");

      // A listing in Leeds takes "barn-halls" inside the CITY namespace first,
      // so the category's per-city route has to be disambiguated even though
      // its national slug is the bare one.
      await makeListing(
        tx, { cityId: city, verticalId: v, primaryCategoryId: decoy }, { name: "Barn Halls" },
      );
      const cat = await makeCategory(tx, v, "Barn Halls");
      const scoped = await linkCategoryToCity(tx, cat, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat });
      await indexable(tx, city);

      expect(scoped).toBe("barn-halls-2");

      const blocks = await getFooterMatrix(tx, PUBLIC_VIEWER);
      const block = blocks.find((b) => b.name === "Barn Halls");
      expect(block).toBeDefined();
      // The national slug is still the bare one — linking THAT is the 404.
      expect(block?.href).toBe("/categories/barn-halls");
      expect(block?.cities.map((c) => c.href)).toEqual(["/leeds/barn-halls-2"]);
      expect(hrefs(blocks)).not.toContain("/leeds/barn-halls");
    });
  });

  it("drops a category that was never routed in the city rather than inventing a URL", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const routed = await makeCategoryInCity(tx, v, city, "Hotels");
      const unrouted = await makeCategory(tx, v, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: routed });
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: unrouted });
      await indexable(tx, city);

      expect(hrefs(await getFooterMatrix(tx, PUBLIC_VIEWER))).toEqual(["/leeds/hotels"]);
    });
  });
});

describe("getFooterMatrix — shape", () => {
  it("caps each category at citiesPerCategory, keeping the biggest", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const cat = await makeCategory(tx, v, "Barn Halls");
      const names = ["Alpha", "Bravo", "Charlie", "Delta"];
      // Alpha gets 1 listing, Bravo 2, Charlie 3, Delta 4.
      for (const [i, name] of names.entries()) {
        const city = await makeCity(tx, name, "Region");
        await linkCategoryToCity(tx, cat, city, "Barn Halls");
        for (let n = 0; n <= i; n++) {
          await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat });
        }
        await indexable(tx, city);
      }

      const blocks = await getFooterMatrix(tx, PUBLIC_VIEWER, { citiesPerCategory: 2 });
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.cities.map((c) => c.name)).toEqual(["Delta", "Charlie"]);
      expect(blocks[0]?.cities.map((c) => c.listingCount)).toEqual([4, 3]);
    });
  });

  it("returns nothing when citiesPerCategory is zero", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat });
      await indexable(tx, city);

      expect(await getFooterMatrix(tx, PUBLIC_VIEWER, { citiesPerCategory: 0 })).toEqual([]);
    });
  });

  it("orders categories by sortOrder", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const first = await makeCategoryInCity(tx, v, city, "Zulu Halls");
      const second = await makeCategoryInCity(tx, v, city, "Alpha Halls");
      await tx.update(schema.categories).set({ sortOrder: 1 }).where(eq(schema.categories.id, first));
      await tx.update(schema.categories).set({ sortOrder: 2 }).where(eq(schema.categories.id, second));
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: first });
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: second });
      await indexable(tx, city);

      expect((await getFooterMatrix(tx, PUBLIC_VIEWER)).map((b) => b.name))
        .toEqual(["Zulu Halls", "Alpha Halls"]);
    });
  });
});

describe("getFooterMatrix — viewer", () => {
  it("ignores unpublished listings for the public", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { status: "draft" });
      await indexable(tx, city);

      expect(await getFooterMatrix(tx, PUBLIC_VIEWER)).toEqual([]);
    });
  });

  it("counts unpublished listings for an admin", async () => {
    await withTestDb(async (tx) => {
      const v = await makeVertical(tx);
      const city = await makeCity(tx, "Leeds", "West Yorkshire");
      const cat = await makeCategoryInCity(tx, v, city, "Barn Halls");
      await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat }, { status: "draft" });
      await indexable(tx, city);

      expect(hrefs(await getFooterMatrix(tx, ADMIN))).toEqual(["/leeds/barn-halls"]);
    });
  });
});

describe("getFooterMatrix — cost", () => {
  /**
   * The footer renders on every page of a site with thousands of pages, so the
   * whole matrix must be ONE round trip — not one query per category. This
   * mirrors withTestDb but attaches a logger so the statements can be counted.
   */
  it("issues exactly one statement for the whole matrix", async () => {
    const url =
      process.env.TEST_DATABASE_URL ??
      "postgres://directory:directory@localhost:5433/directory_test";
    const statements: string[] = [];
    const client = postgres(url, { max: 1 });
    const database = drizzle(client, {
      schema,
      logger: { logQuery: (query) => statements.push(query) },
    });

    try {
      await database
        .transaction(async (raw) => {
          const tx = raw as unknown as TestDb;
          const v = await makeVertical(tx);
          for (const name of ["Alpha", "Bravo", "Charlie"]) {
            const city = await makeCity(tx, name, "Region");
            const cat = await makeCategoryInCity(tx, v, city, `${name} Halls`);
            await makeListing(tx, { cityId: city, verticalId: v, primaryCategoryId: cat });
            await indexable(tx, city);
          }

          statements.length = 0;
          const blocks = await getFooterMatrix(tx, PUBLIC_VIEWER);
          expect(blocks).toHaveLength(3);
          expect(statements).toHaveLength(1);

          throw new Error("rollback");
        })
        .catch((e: unknown) => {
          if (!(e instanceof Error) || e.message !== "rollback") throw e;
        });
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
