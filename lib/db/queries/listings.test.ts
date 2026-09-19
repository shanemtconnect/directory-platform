import { describe, it, expect } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import { listListings, countListings } from "./listings";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeScaffold, makeListing, makeCategoryInCity, linkCategoryToCity, makeVertical, makeCity } from "@/test/factories";

const ALL_STATUSES = ["draft", "pending", "published", "rejected", "archived", "removed"] as const;
const ADMIN = { role: "admin", userId: "admin-1" } as const;

async function seedOnePerStatus(tx: TestDb) {
  const ctx = await makeScaffold(tx);
  for (const status of ALL_STATUSES) {
    await makeListing(tx, ctx, { status, name: `${status} venue` });
  }
  return ctx;
}

describe("listListings", () => {
  it("never returns an unpublished listing to the public", async () => {
    await withTestDb(async (tx) => {
      const { cityId } = await seedOnePerStatus(tx);
      const rows = await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("published");
    });
  });

  it("hides unpublished listings from a signed-in non-admin too", async () => {
    await withTestDb(async (tx) => {
      const { cityId } = await seedOnePerStatus(tx);
      const rows = await listListings(tx, { role: "owner", userId: "u1" }, { type: "city", cityId });
      expect(rows).toHaveLength(1);
    });
  });

  it("returns every status to an admin", async () => {
    await withTestDb(async (tx) => {
      const { cityId } = await seedOnePerStatus(tx);
      const rows = await listListings(tx, ADMIN, { type: "city", cityId });
      expect(rows).toHaveLength(ALL_STATUSES.length);
    });
  });

  it("scopes to the city, excluding listings in another city", async () => {
    await withTestDb(async (tx) => {
      const a = await makeScaffold(tx);
      const verticalId = a.verticalId;
      const otherCity = await makeCity(tx, "Bristol", "Bristol");
      // Same global category, routed in a second city.
      await linkCategoryToCity(tx, a.primaryCategoryId, otherCity, "Barn Venues");
      const otherCat = a.primaryCategoryId;
      await makeListing(tx, a, { name: "in leeds" });
      await makeListing(tx, { cityId: otherCity, verticalId, primaryCategoryId: otherCat }, { name: "in bristol" });

      const rows = await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: a.cityId });
      expect(rows.map((r) => r.name)).toEqual(["in leeds"]);
    });
  });

  it("scopes to a category within a city", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const second = await makeCategoryInCity(tx, ctx.verticalId, ctx.cityId, "Country Houses");
      await makeListing(tx, ctx, { name: "a barn" });
      await makeListing(tx, { ...ctx, primaryCategoryId: second }, { name: "a country house" });

      const rows = await listListings(tx, PUBLIC_VIEWER, {
        type: "city-category", cityId: ctx.cityId, categoryId: second,
      });
      expect(rows.map((r) => r.name)).toEqual(["a country house"]);
    });
  });

  it("scopes to a vertical in local-multi-vertical mode", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const otherVertical = await makeVertical(tx, "Plumbers");
      const otherCat = await makeCategoryInCity(tx, otherVertical, ctx.cityId, "Emergency Plumbers");
      await makeListing(tx, ctx, { name: "a venue" });
      await makeListing(tx, { ...ctx, verticalId: otherVertical, primaryCategoryId: otherCat }, { name: "a plumber" });

      const rows = await listListings(tx, PUBLIC_VIEWER, { type: "vertical", verticalId: otherVertical });
      expect(rows.map((r) => r.name)).toEqual(["a plumber"]);
    });
  });

  it("paginates at 24 by default", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      for (let i = 0; i < 30; i++) await makeListing(tx, ctx, { name: `Venue ${i}` });
      expect(await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId })).toHaveLength(24);
      expect(await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId }, { page: 2 })).toHaveLength(6);
    });
  });

  it("returns no overlap between page 1 and page 2", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      for (let i = 0; i < 30; i++) await makeListing(tx, ctx, { name: `Venue ${i}` });
      const p1 = (await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId }, { page: 1 })).map((r) => r.id);
      const p2 = (await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId }, { page: 2 })).map((r) => r.id);
      expect(new Set([...p1, ...p2]).size).toBe(30);
    });
  });

  it("treats page 0 and negative pages as page 1 rather than throwing an offset error", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "only one" });
      expect(await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId }, { page: 0 })).toHaveLength(1);
      expect(await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId }, { page: -3 })).toHaveLength(1);
    });
  });

  it("applies the ranking order, so premium leads", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "free one", tier: "free" });
      await makeListing(tx, ctx, { name: "premium one", tier: "premium" });
      const rows = await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId });
      expect(rows[0]?.name).toBe("premium one");
    });
  });
});

describe("countListings", () => {
  it("counts only what the viewer may see", async () => {
    await withTestDb(async (tx) => {
      const { cityId } = await seedOnePerStatus(tx);
      expect(await countListings(tx, PUBLIC_VIEWER, { type: "city", cityId })).toBe(1);
      expect(await countListings(tx, ADMIN, { type: "city", cityId })).toBe(ALL_STATUSES.length);
    });
  });
});

describe("publicListingColumns", () => {
  /**
   * The submitter's email, their IP, the moderator's rejection note and the
   * verification evidence all live on the same row as the public listing, so a
   * `select()` with no projection ships every one of them to the browser.
   */
  async function seedSensitive(tx: TestDb) {
    const ctx = await makeScaffold(tx);
    await makeListing(tx, ctx, {
      name: "Sensitive one",
      submittedByEmail: "sam@example.co.uk",
      rejectedReason: "duplicate of another row",
      verificationChecks: { companiesHouse: "12345678" },
      customFields: { capacity_seated: 120, submission: { ip: "203.0.113.9" } },
    });
    return ctx;
  }

  it("never leaks submitter, moderation or verification fields to the public", async () => {
    await withTestDb(async (tx) => {
      const ctx = await seedSensitive(tx);
      const [row] = await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId });
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("submittedByEmail");
      expect(row).not.toHaveProperty("verificationChecks");
      expect(row).not.toHaveProperty("rejectedReason");
      expect(row?.customFields).not.toHaveProperty("submission");
    });
  });

  it("keeps the custom fields the site actually renders", async () => {
    await withTestDb(async (tx) => {
      const ctx = await seedSensitive(tx);
      const [row] = await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId });
      expect(row?.customFields).toEqual({ capacity_seated: 120 });
    });
  });

  it("leaves a listing with no custom fields at all as null", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "Plain one" });
      const [row] = await listListings(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId });
      expect(row?.customFields).toBeNull();
    });
  });
});
