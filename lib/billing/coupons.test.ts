import { describe, expect, it } from "vitest";
import {
  applyDiscount,
  couponRejectionMessage,
  discountSummary,
  eligibility,
  normaliseCode,
  type CouponRecord,
} from "./coupons";

const AT = new Date("2026-09-12T12:00:00Z");

function coupon(patch: Partial<CouponRecord> = {}): CouponRecord {
  return {
    id: "c-1",
    code: "LAUNCH25",
    discountType: "percent",
    value: "25.00",
    appliesToTiers: null,
    appliesToIntervals: null,
    maxRedemptions: null,
    redemptionCount: 0,
    startsAt: null,
    expiresAt: null,
    isActive: true,
    ...patch,
  };
}

describe("normaliseCode", () => {
  it("is case- and space-insensitive, because a code is typed by hand", () => {
    expect(normaliseCode("  launch25 ")).toBe("LAUNCH25");
    expect(normaliseCode("")).toBe("");
  });
});

describe("eligibility", () => {
  const ctx = { tier: "premium" as const, interval: "annual" as const, at: AT };

  it("accepts an open coupon", () => {
    expect(eligibility(coupon(), ctx)).toBeNull();
  });

  it("rejects an inactive one", () => {
    expect(eligibility(coupon({ isActive: false }), ctx)).toBe("inactive");
  });

  it("rejects outside its window, at both ends", () => {
    expect(eligibility(coupon({ startsAt: new Date("2026-10-01T00:00:00Z") }), ctx)).toBe("not-started");
    expect(eligibility(coupon({ expiresAt: new Date("2026-09-01T00:00:00Z") }), ctx)).toBe("expired");
  });

  it("treats the boundaries as inclusive of the start and exclusive of the end", () => {
    expect(eligibility(coupon({ startsAt: AT }), ctx)).toBeNull();
    expect(eligibility(coupon({ expiresAt: AT }), ctx)).toBe("expired");
  });

  it("rejects a tier or interval the coupon was not issued for", () => {
    expect(eligibility(coupon({ appliesToTiers: ["essential"] }), ctx)).toBe("wrong-tier");
    expect(eligibility(coupon({ appliesToIntervals: ["monthly"] }), ctx)).toBe("wrong-interval");
    expect(eligibility(coupon({ appliesToTiers: ["premium"] }), ctx)).toBeNull();
  });

  it("rejects once the redemption cap is reached", () => {
    expect(eligibility(coupon({ maxRedemptions: 1, redemptionCount: 1 }), ctx)).toBe("exhausted");
    expect(eligibility(coupon({ maxRedemptions: 1, redemptionCount: 0 }), ctx)).toBeNull();
    // Null means unlimited, not zero.
    expect(eligibility(coupon({ maxRedemptions: null, redemptionCount: 999 }), ctx)).toBeNull();
  });

  it("gives every rejection a sentence a buyer can act on", () => {
    for (const reason of ["inactive", "not-started", "expired", "exhausted", "wrong-tier", "wrong-interval", "unknown"] as const) {
      expect(couponRejectionMessage(reason).length).toBeGreaterThan(10);
    }
  });
});

describe("applyDiscount", () => {
  const base = { value: "249.00", currency_code: "GBP" };

  it("takes a percentage off, rounded to the penny", () => {
    expect(applyDiscount(base, coupon({ discountType: "percent", value: "25.00" }))).toEqual({
      value: "186.75",
      currency_code: "GBP",
    });
  });

  it("rounds half to the nearest penny rather than truncating", () => {
    // 9.90 monthly, 33% off = 6.633 -> 6.63
    expect(
      applyDiscount({ value: "9.90", currency_code: "GBP" }, coupon({ value: "33.00" })).value,
    ).toBe("6.63");
  });

  it("takes a fixed amount off", () => {
    expect(
      applyDiscount(base, coupon({ discountType: "fixed", value: "50.00" })).value,
    ).toBe("199.00");
  });

  it("never goes below zero, and never below zero by a rounding error", () => {
    expect(
      applyDiscount(base, coupon({ discountType: "fixed", value: "999.00" })).value,
    ).toBe("0.00");
    expect(applyDiscount(base, coupon({ value: "100.00" })).value).toBe("0.00");
  });

  it("keeps the currency of the price, never the coupon", () => {
    expect(applyDiscount({ value: "10.00", currency_code: "EUR" }, coupon()).currency_code).toBe("EUR");
  });
});

describe("discountSummary", () => {
  it("describes a percentage without inventing a currency", () => {
    expect(discountSummary(coupon({ discountType: "percent", value: "25.00" }))).toContain("25%");
  });

  it("describes a fixed discount in minor-unit-exact major units", () => {
    expect(discountSummary(coupon({ discountType: "fixed", value: "7.50" }))).toContain("7.50");
  });
});
