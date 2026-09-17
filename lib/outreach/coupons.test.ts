import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { coupons } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { createOutreachCoupons } from "./coupons";

const ADMIN: Viewer = { role: "admin", userId: "00000000-0000-4000-8000-00000000adm1" };

describe("createOutreachCoupons", () => {
  it("mints single-use percent coupons grouped by batch", async () => {
    await withTestDb(async (tx) => {
      const expiresAt = new Date("2026-12-31T23:59:59Z");
      const batch = await createOutreachCoupons(tx, ADMIN, {
        count: 3, percentOff: 50, expiresAt, description: "Leeds outreach",
      });

      expect(batch.codes).toHaveLength(3);
      const rows = await tx.select().from(coupons).where(eq(coupons.batchId, batch.batchId));
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({
          discountType: "percent",
          value: "50.00",
          // Single use is the whole point: a code that leaks onto a deals site
          // discounts every subscription sold that month.
          maxRedemptions: 1,
          redemptionCount: 0,
          isActive: true,
          description: "Leeds outreach",
        });
        expect(row.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
        expect(row.code).toMatch(/^SAVE50-[A-Z0-9]{6}$/);
      }
    });
  });

  it("gives every coupon its own code", async () => {
    await withTestDb(async (tx) => {
      const batch = await createOutreachCoupons(tx, ADMIN, { count: 50, percentOff: 25 });
      expect(new Set(batch.codes).size).toBe(50);
    });
  });

  it("keeps separate batches separate", async () => {
    await withTestDb(async (tx) => {
      const a = await createOutreachCoupons(tx, ADMIN, { count: 2, percentOff: 50 });
      const b = await createOutreachCoupons(tx, ADMIN, { count: 2, percentOff: 50 });
      expect(a.batchId).not.toBe(b.batchId);
      expect(await tx.select().from(coupons).where(eq(coupons.batchId, a.batchId))).toHaveLength(2);
    });
  });

  it("works around a code that is already taken", async () => {
    await withTestDb(async (tx) => {
      // Collisions are rare but the unique index is the guarantee, not the
      // generator; a throw here would abandon a half-written batch.
      await tx.insert(coupons).values({
        code: "SAVE50-AAAAAA", discountType: "percent", value: "50.00",
      });
      const batch = await createOutreachCoupons(tx, ADMIN, {
        count: 5,
        percentOff: 50,
        codeFor: (i, attempt) =>
          attempt === 0 && i < 2 ? "SAVE50-AAAAAA" : `SAVE50-B${i}${i}${i}${i}${i}`,
      });
      expect(new Set(batch.codes).size).toBe(5);
      expect(batch.codes).not.toContain("SAVE50-AAAAAA");
    });
  });

  it("refuses a percentage that is not a discount", async () => {
    await withTestDb(async (tx) => {
      for (const percentOff of [0, -5, 101]) {
        await expect(
          createOutreachCoupons(tx, ADMIN, { count: 1, percentOff }),
        ).rejects.toThrow(/percent/i);
      }
    });
  });

  it("is admin-only", async () => {
    await withTestDb(async (tx) => {
      await expect(
        createOutreachCoupons(tx, PUBLIC_VIEWER, { count: 1, percentOff: 50 }),
      ).rejects.toThrow(/FORBIDDEN/);
    });
  });
});
