import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { coupons, couponRedemptions } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { previewCoupon, redeemCoupon } from "./coupons";

const OWNER = { role: "user" as const, userId: "u-1" };
const ADMIN = { role: "admin" as const, userId: "a-1" };
const CTX = { tier: "premium" as const, interval: "annual" as const };

async function makeCoupon(
  tx: TestDb,
  patch: Partial<typeof coupons.$inferInsert> = {},
): Promise<string> {
  const [row] = await tx
    .insert(coupons)
    .values({
      code: `TEST-${randomUUID().slice(0, 8)}`.toUpperCase(),
      discountType: "percent",
      value: "25.00",
      ...patch,
    })
    .returning({ id: coupons.id, code: coupons.code });
  return row!.code;
}

describe("previewCoupon", () => {
  it("finds a code whatever case it was typed in", async () => {
    await withTestDb(async (tx) => {
      const code = await makeCoupon(tx);
      const out = await previewCoupon(tx, OWNER, { code: ` ${code.toLowerCase()} `, ...CTX });
      expect(out.outcome).toBe("ok");
    });
  });

  it("reports an unknown code as unknown rather than throwing", async () => {
    await withTestDb(async (tx) => {
      const out = await previewCoupon(tx, OWNER, { code: "NO-SUCH-CODE", ...CTX });
      expect(out).toEqual({ outcome: "rejected", reason: "unknown" });
    });
  });

  it("applies the eligibility rules against the database row", async () => {
    await withTestDb(async (tx) => {
      const code = await makeCoupon(tx, { appliesToTiers: ["essential"] });
      const out = await previewCoupon(tx, OWNER, { code, ...CTX });
      expect(out).toEqual({ outcome: "rejected", reason: "wrong-tier" });
    });
  });

  it("refuses an anonymous viewer — a coupon is applied by the owner buying", async () => {
    await withTestDb(async (tx) => {
      const code = await makeCoupon(tx);
      await expect(previewCoupon(tx, { role: "public" }, { code, ...CTX })).rejects.toThrow(
        "FORBIDDEN",
      );
    });
  });

  it("counts nothing — a preview must be repeatable", async () => {
    await withTestDb(async (tx) => {
      const code = await makeCoupon(tx, { maxRedemptions: 1 });
      await previewCoupon(tx, OWNER, { code, ...CTX });
      await previewCoupon(tx, OWNER, { code, ...CTX });
      const [row] = await tx.select().from(coupons).where(eq(coupons.code, code));
      expect(row!.redemptionCount).toBe(0);
    });
  });
});

describe("redeemCoupon", () => {
  it("records the redemption and moves the counter", async () => {
    await withTestDb(async (tx) => {
      const code = await makeCoupon(tx, { maxRedemptions: 2 });
      const out = await redeemCoupon(tx, OWNER, { code, ...CTX, profileId: null });
      expect(out.outcome).toBe("ok");

      const [row] = await tx.select().from(coupons).where(eq(coupons.code, code));
      expect(row!.redemptionCount).toBe(1);

      const redemptions = await tx
        .select()
        .from(couponRedemptions)
        .where(eq(couponRedemptions.couponId, row!.id));
      expect(redemptions).toHaveLength(1);
    });
  });

  it("refuses once the cap is reached", async () => {
    await withTestDb(async (tx) => {
      const code = await makeCoupon(tx, { maxRedemptions: 1 });
      expect((await redeemCoupon(tx, OWNER, { code, ...CTX, profileId: null })).outcome).toBe("ok");
      expect(await redeemCoupon(tx, ADMIN, { code, ...CTX, profileId: null })).toEqual({
        outcome: "rejected",
        reason: "exhausted",
      });
    });
  });
});

/**
 * The one test in this file that cannot use the rollback harness.
 *
 * Two transactions have to be in flight AT THE SAME TIME against COMMITTED
 * data for the row lock to mean anything, and `withTestDb` gives one
 * transaction that is thrown away. So this opens its own connections, commits
 * a coupon, races two redemptions and cleans up after itself.
 */
describe("redeemCoupon concurrency", () => {
  const url =
    process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
  const client = postgres(url, { max: 4 });
  const database = drizzle(client, { schema });
  const code = `RACE-${randomUUID().slice(0, 8)}`.toUpperCase();

  afterAll(async () => {
    const [row] = await database.select({ id: coupons.id }).from(coupons).where(eq(coupons.code, code));
    if (row) {
      await database.delete(couponRedemptions).where(eq(couponRedemptions.couponId, row.id));
      await database.delete(coupons).where(eq(coupons.id, row.id));
    }
    await client.end({ timeout: 5 });
  });

  it("lets exactly one of two simultaneous redemptions of a single-use code through", async () => {
    await database.insert(coupons).values({
      code,
      discountType: "percent",
      value: "50.00",
      maxRedemptions: 1,
    });

    const attempt = () =>
      database.transaction(async (tx) =>
        redeemCoupon(tx as unknown as TestDb, OWNER, { code, ...CTX, profileId: null }),
      );

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["ok", "rejected"]);

    const [row] = await database.select().from(coupons).where(eq(coupons.code, code));
    expect(row!.redemptionCount).toBe(1);

    const redemptions = await database
      .select()
      .from(couponRedemptions)
      .where(eq(couponRedemptions.couponId, row!.id));
    expect(redemptions).toHaveLength(1);
  });
});
