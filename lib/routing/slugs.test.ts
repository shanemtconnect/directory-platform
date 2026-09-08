import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { withTestDb, type TestDb } from "@/test/db";
import {
  makeCategory, makeCategoryInCity, makeCity, makeListing, makeScaffold, makeVertical,
} from "@/test/factories";
import { allocateSlug, reallocateSlug, resolveSlug, seedReservedSlugs, ROOT_SCOPE, SlugError } from "./slugs";
import { categories, cities, listings, redirects, slugs } from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
import { eq } from "drizzle-orm";

describe("allocateSlug", () => {
  it("allocates the desired slug when free", async () => {
    await withTestDb(async (tx) => {
      const got = await allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Manchester", kind: "city", entityId: randomUUID(),
      });
      expect(got).toBe("manchester");
    });
  });

  it("first city to claim a slug keeps it; the second is disambiguated by region", async () => {
    await withTestDb(async (tx) => {
      const a = await allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Richmond", kind: "city",
        entityId: randomUUID(), disambiguator: "Greater London",
      });
      const b = await allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Richmond", kind: "city",
        entityId: randomUUID(), disambiguator: "North Yorkshire",
      });
      expect(a).toBe("richmond");
      expect(b).toBe("richmond-north-yorkshire");
    });
  });

  it("appends a numeric suffix when even the disambiguated slug is taken", async () => {
    await withTestDb(async (tx) => {
      const args = { parentScope: ROOT_SCOPE, kind: "city" as const, disambiguator: "Kent" };
      await allocateSlug(tx, { ...args, desired: "Ashford", entityId: randomUUID() });
      await allocateSlug(tx, { ...args, desired: "Ashford", entityId: randomUUID() });
      const third = await allocateSlug(tx, { ...args, desired: "Ashford", entityId: randomUUID() });
      expect(third).toBe("ashford-kent-2");
    });
  });

  it("refuses a reserved slug at the root scope", async () => {
    await withTestDb(async (tx) => {
      await expect(allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Pricing", kind: "city", entityId: randomUUID(),
      })).rejects.toThrow(/reserved/i);
    });
  });

  it("allows a reserved word inside a city scope, where no static route exists", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      const got = await allocateSlug(tx, {
        parentScope: cityId, desired: "Pricing", kind: "listing", entityId: randomUUID(),
      });
      expect(got).toBe("pricing");
    });
  });

  it("refuses an empty slug", async () => {
    await withTestDb(async (tx) => {
      await expect(allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "!!!", kind: "city", entityId: randomUUID(),
      })).rejects.toThrow(SlugError);
    });
  });

  it("scopes listing slugs per city, so the same slug is free in another city", async () => {
    await withTestDb(async (tx) => {
      const cityA = randomUUID(), cityB = randomUUID();
      const a = await allocateSlug(tx, { parentScope: cityA, desired: "The Barn", kind: "listing", entityId: randomUUID() });
      const b = await allocateSlug(tx, { parentScope: cityB, desired: "The Barn", kind: "listing", entityId: randomUUID() });
      expect(a).toBe("the-barn");
      expect(b).toBe("the-barn");
    });
  });

  it("stops a listing stealing a category slug inside the same city", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: cityId, desired: "Barn Venues", kind: "category", entityId: randomUUID() });
      const listing = await allocateSlug(tx, {
        parentScope: cityId, desired: "Barn Venues", kind: "listing", entityId: randomUUID(),
      });
      expect(listing).not.toBe("barn-venues");
      expect(listing).toMatch(/^barn-venues-\d+$/);
    });
  });

  it("stops a city and a vertical colliding at the root", async () => {
    await withTestDb(async (tx) => {
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Plumbers", kind: "vertical", entityId: randomUUID() });
      const city = await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Plumbers", kind: "city", entityId: randomUUID() });
      expect(city).not.toBe("plumbers");
    });
  });
});

describe("seedReservedSlugs", () => {
  it("is idempotent", async () => {
    await withTestDb(async (tx) => {
      await seedReservedSlugs(tx);
      await expect(seedReservedSlugs(tx)).resolves.not.toThrow();
    });
  });

  it("makes a reserved slug resolvable as kind=static", async () => {
    await withTestDb(async (tx) => {
      await seedReservedSlugs(tx);
      expect((await resolveSlug(tx, ROOT_SCOPE, "pricing"))?.kind).toBe("static");
    });
  });
});

describe("resolveSlug", () => {
  it("returns the kind and entity id", async () => {
    await withTestDb(async (tx) => {
      const entityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId });
      const row = await resolveSlug(tx, ROOT_SCOPE, "leeds");
      expect(row?.kind).toBe("city");
      expect(row?.entityId).toBe(entityId);
    });
  });

  it("is case-insensitive on lookup", async () => {
    await withTestDb(async (tx) => {
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: randomUUID() });
      expect(await resolveSlug(tx, ROOT_SCOPE, "LEEDS")).not.toBeNull();
    });
  });

  it("returns null for an unknown slug", async () => {
    await withTestDb(async (tx) => {
      expect(await resolveSlug(tx, ROOT_SCOPE, "nowhere")).toBeNull();
    });
  });
});

describe("reallocateSlug", () => {
  it("writes a 301 from the old path and frees the old slug", async () => {
    await withTestDb(async (tx) => {
      const entityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Kingston", kind: "city", entityId });

      const next = await reallocateSlug(tx, {
        parentScope: ROOT_SCOPE, entityId, kind: "city",
        newDesired: "Kingston upon Thames",
        oldPath: "/kingston",
        newPathFor: (s) => `/${s}`,
      });
      expect(next).toBe("kingston-upon-thames");

      const [r] = await tx.select().from(redirects).where(eq(redirects.fromPath, "/kingston"));
      expect(r?.toPath).toBe("/kingston-upon-thames");
      expect(r?.statusCode).toBe(301);

      expect(await resolveSlug(tx, ROOT_SCOPE, "kingston")).toBeNull();
      expect((await resolveSlug(tx, ROOT_SCOPE, "kingston-upon-thames"))?.entityId).toBe(entityId);
    });
  });

  it("is a no-op returning the current slug when the name slugifies unchanged", async () => {
    await withTestDb(async (tx) => {
      const entityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Bath", kind: "city", entityId });
      const next = await reallocateSlug(tx, {
        parentScope: ROOT_SCOPE, entityId, kind: "city", newDesired: "Bath",
        oldPath: "/bath", newPathFor: (s) => `/${s}`,
      });
      expect(next).toBe("bath");
      // No self-referential 301 — that way lies a redirect loop generator.
      expect(await tx.select().from(redirects).where(eq(redirects.fromPath, "/bath"))).toHaveLength(0);
    });
  });

  it("collapses a chain of renames so every old URL is one hop from the new one", async () => {
    await withTestDb(async (tx) => {
      const entityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Alpha", kind: "city", entityId });
      await reallocateSlug(tx, {
        parentScope: ROOT_SCOPE, entityId, kind: "city", newDesired: "Beta",
        oldPath: "/alpha", newPathFor: (s) => `/${s}`,
      });
      await reallocateSlug(tx, {
        parentScope: ROOT_SCOPE, entityId, kind: "city", newDesired: "Gamma",
        oldPath: "/beta", newPathFor: (s) => `/${s}`,
      });
      const rows = await tx.select().from(redirects);
      const map = Object.fromEntries(rows.map((r) => [r.fromPath, r.toPath]));
      // Two hops leaks link equity and Google gives up after a handful of them.
      expect(map["/alpha"]).toBe("/gamma");
      expect(map["/beta"]).toBe("/gamma");
    });
  });

  it("throws when the entity has no slug allocated", async () => {
    await withTestDb(async (tx) => {
      await expect(reallocateSlug(tx, {
        parentScope: ROOT_SCOPE, entityId: randomUUID(), kind: "city",
        newDesired: "Nowhere", oldPath: "/nowhere", newPathFor: (s) => `/${s}`,
      })).rejects.toThrow(SlugError);
    });
  });

  it("writes the new slug back to the city row the links are built from", async () => {
    await withTestDb(async (tx) => {
      const cityId = await makeCity(tx, "Kingston", "Greater London");
      await reallocateSlug(tx, {
        parentScope: ROOT_SCOPE, entityId: cityId, kind: "city",
        newDesired: "Kingston upon Thames", oldPath: "/kingston", newPathFor: (s) => `/${s}`,
      });
      const [row] = await tx.select({ slug: cities.slug }).from(cities).where(eq(cities.id, cityId));
      // The sitemap, homepage and category pages all read cities.slug. Leaving
      // it stale emits the old URL everywhere and 301s every internal link.
      expect(row?.slug).toBe("kingston-upon-thames");
    });
  });

  it("writes the new slug back to the listing row too", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      await reallocateSlug(tx, {
        parentScope: ctx.cityId, entityId: listingId, kind: "listing",
        newDesired: "The New Barn", oldPath: "/leeds/the-old-barn",
        newPathFor: (s) => `/leeds/${s}`,
      });
      const [row] = await tx
        .select({ slug: listings.slug }).from(listings).where(eq(listings.id, listingId));
      expect(row?.slug).toBe("the-new-barn");
    });
  });

  it("renaming a category's per-city alias leaves the national page's slug alone", async () => {
    await withTestDb(async (tx) => {
      const verticalId = await makeVertical(tx);
      const cityId = await makeCity(tx);
      const categoryId = await makeCategoryInCity(tx, verticalId, cityId, "Barn Venues");

      // /leeds/barn-venues is an alias. /categories/barn-venues is the identity.
      await reallocateSlug(tx, {
        parentScope: cityId, entityId: categoryId, kind: "category",
        newDesired: "Barns", oldPath: "/leeds/barn-venues",
        newPathFor: (s) => `/leeds/${s}`,
      });

      const [row] = await tx
        .select({ slug: categories.slug }).from(categories).where(eq(categories.id, categoryId));
      expect(row?.slug).toBe("barn-venues");
      expect((await resolveSlug(tx, cityId, "barns"))?.entityId).toBe(categoryId);
    });
  });

  it("renaming a category at the root does move the national page's slug", async () => {
    await withTestDb(async (tx) => {
      const verticalId = await makeVertical(tx);
      const categoryId = await makeCategory(tx, verticalId, "Barn Venues");

      await reallocateSlug(tx, {
        parentScope: ROOT_SCOPE, entityId: categoryId, kind: "category",
        newDesired: "Barns", oldPath: "/categories/barn-venues",
        newPathFor: (s) => `/categories/${s}`,
      });

      const [row] = await tx
        .select({ slug: categories.slug }).from(categories).where(eq(categories.id, categoryId));
      expect(row?.slug).toBe("barns");
    });
  });

  it("refuses to reallocate a static slug", async () => {
    await withTestDb(async (tx) => {
      await seedReservedSlugs(tx);
      await expect(reallocateSlug(tx, {
        parentScope: ROOT_SCOPE, entityId: randomUUID(), kind: "static",
        newDesired: "Prices", oldPath: "/pricing", newPathFor: (s) => `/${s}`,
      })).rejects.toThrow(SlugError);
    });
  });
});

/**
 * The one case a rolled-back single-connection test cannot reach.
 *
 * Two imports of the same business name landing at once used to pass the
 * "is it taken?" check together, and the loser's INSERT raised 23505 — which
 * in Postgres poisons the whole surrounding transaction, so the import aborted
 * rather than taking the next candidate. These two run on their own committed
 * connections; the scope is a fresh uuid so nothing else in the suite sees them.
 */
describe("allocateSlug under concurrency", () => {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgres://directory:directory@localhost:5433/directory_test";

  it("gives two simultaneous callers two different slugs", async () => {
    const scope = randomUUID();
    const clients = [postgres(url, { max: 1 }), postgres(url, { max: 1 })];
    const dbs = clients.map((c) => drizzle(c, { schema }) as unknown as TestDb);
    try {
      const allocated = await Promise.all(
        dbs.map((tx) =>
          allocateSlug(tx, {
            parentScope: scope, desired: "The Barn", kind: "listing", entityId: randomUUID(),
          }),
        ),
      );
      expect(new Set(allocated).size).toBe(2);
      expect(allocated).toContain("the-barn");
      expect(allocated).toContain("the-barn-2");
    } finally {
      // These rows are committed, not rolled back, so clean up after them.
      await dbs[0]?.delete(slugs).where(eq(slugs.parentScope, scope));
      await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
    }
  });
});
