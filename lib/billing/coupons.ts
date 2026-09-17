import type { TierName } from "@/config/types";
import type { Interval } from "@/lib/pricing";
import type { PayPalAmount } from "./paypal";

/**
 * Coupon rules, as pure functions.
 *
 * PayPal has no promotion-code primitive for subscriptions, so this codebase is
 * the enforcer: eligibility, the redemption cap and the arithmetic all happen
 * here, and the result reaches PayPal as a one-cycle plan override. Keeping the
 * rules pure is what makes every edge — the window boundaries, the cap, a 100%
 * code — checkable without a database or a network.
 *
 * Money is computed in minor units throughout. 249.00 less 25% is 186.75, and
 * doing that in floating point major units is how a directory ends up charging
 * 186.74999999999997.
 */

export type DiscountType = "percent" | "fixed";

export interface CouponRecord {
  readonly id: string;
  readonly code: string;
  readonly discountType: DiscountType;
  /** Comes out of a numeric column as a string; never parsed into a float early. */
  readonly value: string;
  readonly appliesToTiers: readonly string[] | null;
  readonly appliesToIntervals: readonly string[] | null;
  readonly maxRedemptions: number | null;
  readonly redemptionCount: number;
  readonly startsAt: Date | null;
  readonly expiresAt: Date | null;
  readonly isActive: boolean;
}

export type CouponRejection =
  | "unknown"
  | "inactive"
  | "not-started"
  | "expired"
  | "exhausted"
  | "wrong-tier"
  | "wrong-interval";

export interface CouponContext {
  readonly tier: TierName;
  readonly interval: Interval;
  readonly at: Date;
}

export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Null means the coupon may be used. Anything else is why it may not. */
export function eligibility(c: CouponRecord, ctx: CouponContext): CouponRejection | null {
  if (!c.isActive) return "inactive";
  if (c.startsAt !== null && ctx.at.getTime() < c.startsAt.getTime()) return "not-started";
  // Exclusive end: a coupon that expires at midnight is not valid at midnight.
  if (c.expiresAt !== null && ctx.at.getTime() >= c.expiresAt.getTime()) return "expired";
  if (c.appliesToTiers !== null && !c.appliesToTiers.includes(ctx.tier)) return "wrong-tier";
  if (c.appliesToIntervals !== null && !c.appliesToIntervals.includes(ctx.interval)) {
    return "wrong-interval";
  }
  // Null is unlimited. Zero is a cap of zero, and is honoured as one.
  if (c.maxRedemptions !== null && c.redemptionCount >= c.maxRedemptions) return "exhausted";
  return null;
}

const MESSAGES: Record<CouponRejection, string> = {
  unknown: "That code was not recognised. Check it and try again.",
  inactive: "That code is no longer available.",
  "not-started": "That code cannot be used yet.",
  expired: "That code has expired.",
  exhausted: "That code has already been used the maximum number of times.",
  "wrong-tier": "That code does not apply to the plan you have chosen.",
  "wrong-interval": "That code does not apply to this billing period.",
};

export function couponRejectionMessage(reason: CouponRejection): string {
  return MESSAGES[reason];
}

const toMinor = (decimal: string): number => Math.round(Number(decimal) * 100);
const toMajor = (minor: number): string => (minor / 100).toFixed(2);

/**
 * The discounted price of ONE billing cycle. The currency is the price's, never
 * the coupon's — a coupon carries a number, not a currency.
 */
export function applyDiscount(base: PayPalAmount, c: CouponRecord): PayPalAmount {
  const baseMinor = toMinor(base.value);
  const off =
    c.discountType === "percent"
      ? Math.round((baseMinor * Number(c.value)) / 100)
      : toMinor(c.value);
  const net = Math.max(0, baseMinor - off);
  return { value: toMajor(net), currency_code: base.currency_code };
}

/** Shown beside the price. Deliberately currency-free for a fixed amount. */
export function discountSummary(c: CouponRecord): string {
  if (c.discountType === "percent") {
    const pct = Number(c.value);
    return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}% off the first payment`;
  }
  return `${toMajor(toMinor(c.value))} off the first payment`;
}
