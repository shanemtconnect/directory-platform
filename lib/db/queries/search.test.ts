import { describe, it, expect } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import { search, searchCount } from "./search";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeVertical, makeCity, makeCategoryInCity, makeListing } from "@/test/factories";

async function scaffold(tx: TestDb) {
  const verticalId = await makeVertical(tx);
  const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
  const bristol = await makeCity(tx, "Bristol", "Bristol");
  const barns = await makeCategoryInCity(tx, verticalId, leeds, "Barn Venues");
  const halls = await makeCategoryInCity(tx, verticalId, leeds, "Historic Halls");
  return { verticalId, leeds, bristol, barns, halls };
}

describe("search", () => {
  it("matches on name, case-insensitively", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      await makeListing(tx, { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns }, { name: "The Old Barn" });
      await makeListing(tx, { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns }, { name: "Riverside Hall" });
      expect((await search(tx, PUBLIC_VIEWER, { q: "old barn" })).rows.map((r) => r.name))
        .toEqual(["The Old Barn"]);
    });
  });

  it("matches on description as well as name", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      await makeListing(tx, { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns },
        { name: "Somewhere", description: "A restored granary with beams." });
      expect((await search(tx, PUBLIC_VIEWER, { q: "granary" })).total).toBe(1);
    });
  });

  it("does NOT match on address — that would return everything in a big city", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      await makeListing(tx, { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns },
        { name: "Somewhere", addressLine1: "12 Granary Wharf" });
      expect((await search(tx, PUBLIC_VIEWER, { q: "granary" })).total).toBe(0);
    });
  });

  it("treats % and _ as literals, not wildcards", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      await makeListing(tx, { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns }, { name: "Alpha" });
      await makeListing(tx, { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns }, { name: "Beta" });
      // A bare % must not match every row.
      expect((await search(tx, PUBLIC_VIEWER, { q: "%" })).total).toBe(0);
      expect((await search(tx, PUBLIC_VIEWER, { q: "_" })).total).toBe(0);
    });
  });

  it("filters by city slug", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      const bristolCat = await makeCategoryInCity(tx, s.verticalId, s.bristol, "Barn Venues 2");
      await makeListing(tx, { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns }, { name: "In Leeds" });
      await makeListing(tx, { cityId: s.bristol, verticalId: s.verticalId, primaryCategoryId: bristolCat }, { name: "In Bristol" });
      expect((await search(tx, PUBLIC_VIEWER, { city: "leeds" })).rows.map((r) => r.name)).toEqual(["In Leeds"]);
    });
  });

  it("filters by category slug", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      await makeListing(tx, { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns }, { name: "A Barn" });
      await makeListing(tx, { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.halls }, { name: "A Hall" });
      expect((await search(tx, PUBLIC_VIEWER, { category: "historic-halls" })).rows.map((r) => r.name))
        .toEqual(["A Hall"]);
    });
  });

  it("never returns an unpublished listing", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      for (const status of ["draft", "pending", "rejected", "archived", "removed"] as const) {
        await makeListing(tx, { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns },
          { status, name: `Hidden ${status}` });
      }
      expect((await search(tx, PUBLIC_VIEWER, { q: "Hidden" })).total).toBe(0);
    });
  });

  it("filters on a searchable boolean custom field", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
      await makeListing(tx, ctx, { name: "With rooms", customFields: { has_accommodation: true } });
      await makeListing(tx, ctx, { name: "No rooms", customFields: { has_accommodation: false } });
      const r = await search(tx, PUBLIC_VIEWER, { fields: { has_accommodation: "true" } });
      expect(r.rows.map((x) => x.name)).toEqual(["With rooms"]);
    });
  });

  it("filters numerically with >= on a searchable number field", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
      await makeListing(tx, ctx, { name: "Small", customFields: { capacity_seated: 40 } });
      await makeListing(tx, ctx, { name: "Large", customFields: { capacity_seated: 250 } });
      const r = await search(tx, PUBLIC_VIEWER, { fields: { capacity_seated: "100" } });
      expect(r.rows.map((x) => x.name)).toEqual(["Large"]);
    });
  });

  it("IGNORES a field key that is not declared searchable — no arbitrary key reaches SQL", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
      await makeListing(tx, ctx, { name: "Anything", customFields: { secret_flag: "x" } });
      // An undeclared key must be dropped, not applied — so all rows come back.
      expect((await search(tx, PUBLIC_VIEWER, { fields: { secret_flag: "x" } })).total).toBe(1);
      expect((await search(tx, PUBLIC_VIEWER, { fields: { "'; drop table listings; --": "x" } })).total).toBe(1);
    });
  });

  it("paginates and reports totals", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
      for (let i = 0; i < 30; i++) await makeListing(tx, ctx, { name: `Venue ${i}` });
      const p1 = await search(tx, PUBLIC_VIEWER, {});
      expect(p1.rows).toHaveLength(24);
      expect(p1.total).toBe(30);
      expect(p1.totalPages).toBe(2);
      expect((await search(tx, PUBLIC_VIEWER, { page: 2 })).rows).toHaveLength(6);
    });
  });

  it("returns the public projection, not the whole row", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
      await makeListing(tx, ctx, {
        name: "Sensitive one",
        submittedByEmail: "sam@example.co.uk",
        rejectedReason: "duplicate",
        verificationChecks: { companiesHouse: "12345678" },
        customFields: { capacity_seated: 120, submission: { ip: "203.0.113.9" } },
      });

      const [row] = (await search(tx, PUBLIC_VIEWER, { q: "Sensitive" })).rows;
      expect(row).not.toHaveProperty("submittedByEmail");
      expect(row).not.toHaveProperty("verificationChecks");
      expect(row).not.toHaveProperty("rejectedReason");
      expect(row?.customFields).toEqual({ capacity_seated: 120 });
    });
  });

  describe("verified filter", () => {
    it("returns only verified listings when verified is true", async () => {
      await withTestDb(async (tx) => {
        const s = await scaffold(tx);
        const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
        await makeListing(tx, ctx, { name: "Verified one", claimStatus: "verified" });
        await makeListing(tx, ctx, { name: "Claimed one", claimStatus: "claimed" });
        await makeListing(tx, ctx, { name: "Unclaimed one", claimStatus: "unclaimed" });

        const r = await search(tx, PUBLIC_VIEWER, { verified: true });
        expect(r.rows.map((x) => x.name)).toEqual(["Verified one"]);
        expect(r.total).toBe(1);
      });
    });

    it("returns every claim status when verified is false or absent", async () => {
      await withTestDb(async (tx) => {
        const s = await scaffold(tx);
        const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
        await makeListing(tx, ctx, { name: "Verified one", claimStatus: "verified" });
        await makeListing(tx, ctx, { name: "Unclaimed one", claimStatus: "unclaimed" });

        expect((await search(tx, PUBLIC_VIEWER, {})).total).toBe(2);
        expect((await search(tx, PUBLIC_VIEWER, { verified: false })).total).toBe(2);
      });
    });

    it("combines the verified filter with q, city and fields", async () => {
      await withTestDb(async (tx) => {
        const s = await scaffold(tx);
        const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
        await makeListing(tx, ctx, { name: "Old Barn Verified", claimStatus: "verified" });
        await makeListing(tx, ctx, { name: "Old Barn Unclaimed", claimStatus: "unclaimed" });
        await makeListing(tx, { ...ctx, cityId: s.bristol }, { name: "Old Barn Elsewhere", claimStatus: "verified" });

        const r = await search(tx, PUBLIC_VIEWER, { q: "old barn", city: "leeds", verified: true });
        expect(r.rows.map((x) => x.name)).toEqual(["Old Barn Verified"]);
      });
    });
  });

  describe("searchCount", () => {
    it("counts only, agreeing with search()'s own total — for the toggle, which has no use for a page of rows", async () => {
      await withTestDb(async (tx) => {
        const s = await scaffold(tx);
        const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
        await makeListing(tx, ctx, { name: "Verified one", claimStatus: "verified" });
        await makeListing(tx, ctx, { name: "Unclaimed one", claimStatus: "unclaimed" });

        expect(await searchCount(tx, PUBLIC_VIEWER, { verified: true })).toBe(1);
        expect(await searchCount(tx, PUBLIC_VIEWER, {})).toBe(2);
        expect(await searchCount(tx, PUBLIC_VIEWER, { verified: true })).toBe(
          (await search(tx, PUBLIC_VIEWER, { verified: true })).total,
        );
      });
    });

    it("combines with q and city, same as search()", async () => {
      await withTestDb(async (tx) => {
        const s = await scaffold(tx);
        const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
        await makeListing(tx, ctx, { name: "Old Barn Verified", claimStatus: "verified" });
        await makeListing(tx, { ...ctx, cityId: s.bristol }, { name: "Old Barn Elsewhere", claimStatus: "verified" });

        expect(await searchCount(tx, PUBLIC_VIEWER, { q: "old barn", city: "leeds", verified: true })).toBe(1);
      });
    });
  });
});

describe("search — publishedAfter (saved-search alerts)", () => {
  it("keeps only listings that went live strictly after the instant — publish time, else creation", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
      const since = new Date("2026-09-20T12:00:00Z");
      const before = new Date("2026-09-19T12:00:00Z");
      const after = new Date("2026-09-21T12:00:00Z");
      await makeListing(tx, ctx, { name: "Before", createdAt: before });
      await makeListing(tx, ctx, { name: "At the instant", createdAt: since });
      await makeListing(tx, ctx, { name: "After", createdAt: after });
      // Submitted before, approved after: new, because it went live after.
      await makeListing(tx, ctx, { name: "Approved after", createdAt: before, publishedAt: after });
      // Created after but published before cannot happen; published before wins either way.
      await makeListing(tx, ctx, { name: "Published before", createdAt: before, publishedAt: before });
      await makeListing(tx, ctx, { name: "After but pending", status: "pending", createdAt: after });

      const result = await search(tx, PUBLIC_VIEWER, { city: "leeds", publishedAfter: since });
      expect(result.rows.map((r) => r.name).sort()).toEqual(["After", "Approved after"]);
      expect(result.total).toBe(2);
      expect(result.rows.find((r) => r.name === "Approved after")?.liveAt).toEqual(after);
      expect(result.rows.find((r) => r.name === "After")?.liveAt).toEqual(after);
      // Absent, nothing changes.
      expect((await search(tx, PUBLIC_VIEWER, { city: "leeds" })).total).toBe(5);
    });
  });

  it("compares at the millisecond a JS Date holds, so a row read back as the watermark is not new again", async () => {
    await withTestDb(async (tx) => {
      const s = await scaffold(tx);
      const ctx = { cityId: s.leeds, verticalId: s.verticalId, primaryCategoryId: s.barns };
      // Default created_at: now(), which Postgres keeps to the microsecond.
      await makeListing(tx, ctx, { name: "Microsecond Barn" });
      const [row] = (await search(tx, PUBLIC_VIEWER, { q: "Microsecond Barn" })).rows;
      expect((await search(tx, PUBLIC_VIEWER, { q: "Microsecond Barn", publishedAfter: row!.liveAt })).total).toBe(0);
    });
  });
});
