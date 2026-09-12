import { eq, sql } from "drizzle-orm";
import { coupons, couponRedemptions } from "@/lib/db/schema";
import { now } from "@/lib/clock";
import {
  eligibility,
  normaliseCode,
  type CouponRecord,
  type CouponRejection,
} from "@/lib/billing/coupons";
import type { TierName } from "@/config/types";
import type { Interval } from "@/lib/pricing";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

/**
 * Coupon lookup and redemption.
 *
 * Two entry points, and the difference between them is the whole point:
 *
 *  - `previewCoupon` is what the checkout form calls while the buyer types. It
 *    takes no lock and counts nothing, so it can be called as often as the
 *    page likes.
 *  - `redeemCoupon` is called once, inside the transaction that creates the
 *    subscription, and takes `SELECT … FOR UPDATE` on the coupon row FIRST.
 *    Without that lock two people redeeming a `max_redemptions: 1` code at the
 *    same moment both read `redemption_count = 0`, both pass the check and both
 *    get the discount. With it the second waits for the first to commit and
 *    then reads the incremented count.
 */

export type CouponOutcome =
  | { outcome: "ok"; coupon: CouponRecord }
  | { outcome: "rejected"; reason: CouponRejection };

export interface CouponLookup {
  code: string;
  tier: TierName;
  interval: Interval;
}

export interface CouponRedemption extends CouponLookup {
  /** profiles.id — never Better Auth's text user id. Null for an admin grant. */
  profileId: string | null;
  listingId?: string | null;
  subscriptionId?: string | null;
}

function assertSignedIn(viewer: Viewer): void {
  // A coupon is applied by the person buying. Nothing anonymous reads this.
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

const COLUMNS = {
  id: coupons.id,
  code: coupons.code,
  discountType: coupons.discountType,
  value: coupons.value,
  appliesToTiers: coupons.appliesToTiers,
  appliesToIntervals: coupons.appliesToIntervals,
  maxRedemptions: coupons.maxRedemptions,
  redemptionCount: coupons.redemptionCount,
  startsAt: coupons.startsAt,
  expiresAt: coupons.expiresAt,
  isActive: coupons.isActive,
};

type Row = {
  id: string;
  code: string;
  discountType: "percent" | "fixed";
  value: string;
  appliesToTiers: string[] | null;
  appliesToIntervals: string[] | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
};

const toRecord = (row: Row): CouponRecord => row;

export async function previewCoupon(
  tx: TestDb,
  viewer: Viewer,
  input: CouponLookup,
): Promise<CouponOutcome> {
  assertSignedIn(viewer);
  const code = normaliseCode(input.code);
  if (code === "") return { outcome: "rejected", reason: "unknown" };

  const [row] = await tx.select(COLUMNS).from(coupons).where(eq(coupons.code, code)).limit(1);
  if (!row) return { outcome: "rejected", reason: "unknown" };

  const record = toRecord(row as Row);
  const reason = eligibility(record, { tier: input.tier, interval: input.interval, at: now() });
  return reason === null ? { outcome: "ok", coupon: record } : { outcome: "rejected", reason };
}

/**
 * Caller supplies the transaction. The lock is held until IT commits, so the
 * count and the subscription it belongs to land together or not at all.
 */
export async function redeemCoupon(
  tx: TestDb,
  viewer: Viewer,
  input: CouponRedemption,
): Promise<CouponOutcome> {
  assertSignedIn(viewer);
  const code = normaliseCode(input.code);
  if (code === "") return { outcome: "rejected", reason: "unknown" };

  // FOR UPDATE, before anything is decided. This is the concurrency control.
  const [row] = await tx
    .select(COLUMNS)
    .from(coupons)
    .where(eq(coupons.code, code))
    .limit(1)
    .for("update");
  if (!row) return { outcome: "rejected", reason: "unknown" };

  const record = toRecord(row as Row);
  const reason = eligibility(record, { tier: input.tier, interval: input.interval, at: now() });
  if (reason !== null) return { outcome: "rejected", reason };

  // Incremented in SQL rather than from the value just read: the lock makes
  // either correct, and this one stays correct if the lock is ever lost.
  await tx
    .update(coupons)
    .set({ redemptionCount: sql`${coupons.redemptionCount} + 1`, updatedAt: now() })
    .where(eq(coupons.id, record.id));

  await tx.insert(couponRedemptions).values({
    couponId: record.id,
    userId: input.profileId,
    listingId: input.listingId ?? null,
    subscriptionId: input.subscriptionId ?? null,
    redeemedAt: now(),
  });

  return { outcome: "ok", coupon: record };
}
