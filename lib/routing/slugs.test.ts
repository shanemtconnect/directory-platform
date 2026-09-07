import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb } from "@/test/db";
import { allocateSlug, reallocateSlug, resolveSlug, seedReservedSlugs, ROOT_SCOPE, SlugError } from "./slugs";
import { redirects } from "@/lib/db/schema";
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

  it("chains correctly across two renames without orphaning the first URL", async () => {
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
      expect(map["/alpha"]).toBe("/beta");
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
});
