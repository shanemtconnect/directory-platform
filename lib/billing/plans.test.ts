import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import {
  PAID_PLANS,
  minorUnits,
  planAmount,
  planEnvVar,
  planIdFor,
  planNameFor,
  tierForPlanId,
  trialDaysFor,
} from "./plans";

const env = {
  PAYPAL_PLAN_ESSENTIAL_MONTHLY: "P-ESS-M",
  PAYPAL_PLAN_ESSENTIAL_ANNUAL: "P-ESS-A",
  PAYPAL_PLAN_PREMIUM_MONTHLY: "P-PRE-M",
  PAYPAL_PLAN_PREMIUM_ANNUAL: "P-PRE-A",
};

describe("planEnvVar", () => {
  it("names one variable per tier and interval", () => {
    expect(planEnvVar("essential", "monthly")).toBe("PAYPAL_PLAN_ESSENTIAL_MONTHLY");
    expect(planEnvVar("premium", "annual")).toBe("PAYPAL_PLAN_PREMIUM_ANNUAL");
  });
});

describe("PAID_PLANS", () => {
  it("is derived from the config, never a hand-written list", () => {
    // Every tier that costs money, in both intervals. A clone that adds a
    // fourth tier gets a fifth and sixth plan without editing this file.
    const paidTiers = Object.entries(siteConfig.tiers)
      .filter(([, t]) => t.priceAnnual > 0 || t.priceMonthly > 0)
      .map(([name]) => name);
    expect(PAID_PLANS).toHaveLength(paidTiers.length * 2);
    expect(PAID_PLANS.map((p) => p.tier)).not.toContain("free");
  });
});

describe("planIdFor", () => {
  it("reads the id out of the environment", () => {
    expect(planIdFor("essential", "annual", env)).toBe("P-ESS-A");
  });

  it("returns null when the plan is not configured", () => {
    expect(planIdFor("premium", "monthly", {})).toBeNull();
    expect(planIdFor("premium", "monthly", { PAYPAL_PLAN_PREMIUM_MONTHLY: "  " })).toBeNull();
  });

  it("refuses a free tier — there is nothing to bill", () => {
    expect(planIdFor("free", "annual", env)).toBeNull();
  });
});

describe("tierForPlanId", () => {
  it("maps a known plan id back to its tier and interval", () => {
    expect(tierForPlanId("P-PRE-A", env)).toEqual({ tier: "premium", interval: "annual" });
  });

  it("returns null for an unknown plan rather than guessing a tier", () => {
    expect(tierForPlanId("P-SOMETHING-ELSE", env)).toBeNull();
  });

  it("never matches a blank id against an unset variable", () => {
    expect(tierForPlanId("", { PAYPAL_PLAN_PREMIUM_ANNUAL: "" })).toBeNull();
    expect(tierForPlanId("   ", {})).toBeNull();
  });
});

describe("money", () => {
  it("counts in minor units so twelve monthlies do not drift", () => {
    expect(minorUnits(24.9)).toBe(2490);
    expect(minorUnits(24.9) * 12).toBe(29880);
  });

  it("formats a PayPal amount from the config price, exact to the penny", () => {
    const premium = siteConfig.tiers.premium;
    expect(planAmount("premium", "monthly")).toEqual({
      value: premium.priceMonthly.toFixed(2),
      currency_code: siteConfig.currency,
    });
    expect(planAmount("premium", "annual").value).toBe(premium.priceAnnual.toFixed(2));
  });

  it("has no amount for a free tier", () => {
    expect(() => planAmount("free", "annual")).toThrow();
  });
});

describe("trialDaysFor", () => {
  it("comes from the tier spec", () => {
    expect(trialDaysFor("premium")).toBe(siteConfig.tiers.premium.trialDays);
    expect(trialDaysFor("free")).toBe(0);
  });
});

describe("planNameFor", () => {
  it("is stable, so the setup script is idempotent by name", () => {
    expect(planNameFor("essential", "annual")).toBe(planNameFor("essential", "annual"));
    expect(planNameFor("essential", "annual")).not.toBe(planNameFor("essential", "monthly"));
  });
});
