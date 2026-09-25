import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { coupons, couponRedemptions } from "@/lib/db/schema";
import type { TestDb } from "@/test/db";
import { sweepRaceRows } from "@/test/race";
import { redeemCoupon } from "./coupons";

const OWNER = { role: "user" as const, userId: "u-1" };
const CTX = { tier: "premium" as const, interval: "annual" as const };

/**
 * The one coupons test that cannot use the rollback harness, so it lives in
 * its own file and runs in the race suite (vitest.race.config.ts), alone.
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
    // Finds the coupon, and its redemptions, by the RACE- prefix.
    try {
      await sweepRaceRows(client);
    } finally {
      await client.end({ timeout: 5 });
    }
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
