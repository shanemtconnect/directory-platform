import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import {
  PAID_PLANS,
  minorUnits,
  planAmount,
  planEnvVar,
  planIdFor,
  planNameFor,
  planRequestBody,
  firstPaidCycleSequence,
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

describe("planRequestBody", () => {
  const body = planRequestBody("premium", "annual", "PROD-1");
  const cycles = body.billing_cycles;

  it("puts the free trial first, priced at nothing", () => {
    expect(cycles[0]).toMatchObject({
      tenure_type: "TRIAL",
      sequence: 1,
      total_cycles: 1,
      frequency: { interval_unit: "DAY", interval_count: siteConfig.tiers.premium.trialDays },
    });
    expect(cycles[0]!.pricing_scheme.fixed_price.value).toBe("0.00");
  });

  it("splits the paid part into a discountable first cycle and an open-ended one", () => {
    // This split is the ONLY thing that makes "25% off the first payment"
    // expressible as a PayPal plan override. Overriding a single open-ended
    // cycle would discount every renewal for ever.
    const [, first, ongoing] = cycles;
    expect(first).toMatchObject({ tenure_type: "REGULAR", sequence: 2, total_cycles: 1 });
    expect(ongoing).toMatchObject({ tenure_type: "REGULAR", sequence: 3, total_cycles: 0 });
    expect(firstPaidCycleSequence("premium")).toBe(first!.sequence);
  });

  it("prices both paid cycles from the config, to the penny", () => {
    const expected = siteConfig.tiers.premium.priceAnnual.toFixed(2);
    expect(cycles[1]!.pricing_scheme.fixed_price.value).toBe(expected);
    expect(cycles[2]!.pricing_scheme.fixed_price.value).toBe(expected);
  });

  it("bills yearly for annual and monthly for monthly", () => {
    expect(cycles[1]!.frequency).toEqual({ interval_unit: "YEAR", interval_count: 1 });
    expect(planRequestBody("premium", "monthly", "PROD-1").billing_cycles[1]!.frequency).toEqual({
      interval_unit: "MONTH",
      interval_count: 1,
    });
  });

  it("omits the trial cycle for a tier that has none", () => {
    // Read through a widened view: the config asserts literal types, and a
    // clone that sets trialDays to 0 must still get a valid plan.
    const trialDays: number = siteConfig.tiers.essential.trialDays;
    const cyclesForEssential = planRequestBody("essential", "annual", "PROD-1").billing_cycles;
    expect(cyclesForEssential[0]!.tenure_type).toBe(trialDays > 0 ? "TRIAL" : "REGULAR");
    expect(firstPaidCycleSequence("essential")).toBe(trialDays > 0 ? 2 : 1);
    expect(cyclesForEssential).toHaveLength(trialDays > 0 ? 3 : 2);
  });

  it("carries no tax block — the seller is not VAT registered", () => {
    expect(body).not.toHaveProperty("taxes");
  });

  it("refuses to build a plan for a free tier", () => {
    expect(() => planRequestBody("free", "annual", "PROD-1")).toThrow();
  });
});
