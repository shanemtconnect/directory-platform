import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import { PLAN_ENV_VARS as ENV_GATE_VARS } from "@/config/validate";
import {
  PAID_PLANS,
  minorUnits,
  planAmount,
  planEnvVar,
  planIdFor,
  planNameFor,
  planRequestBody,
  PLAN_ENV_VARS,
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

describe("PLAN_ENV_VARS", () => {
  it("is the same list the boot check enforces", () => {
    // config/validate.ts derives its own copy, because next.config.ts compiles
    // it with relative resolution and cannot reach lib/. This is the assertion
    // that stops the two drifting apart.
    expect([...PLAN_ENV_VARS].sort()).toEqual([...ENV_GATE_VARS].sort());
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

  it("makes the first payment a priced TRIAL cycle, then the one open-ended REGULAR", () => {
    // This split is the ONLY thing that makes "25% off the first payment"
    // expressible as a PayPal plan override. Overriding the open-ended cycle
    // would discount every renewal for ever. It is a TRIAL rather than a
    // second REGULAR because PayPal permits exactly one regular cycle.
    const [, first, ongoing] = cycles;
    expect(first).toMatchObject({ tenure_type: "TRIAL", sequence: 2, total_cycles: 1 });
    expect(ongoing).toMatchObject({ tenure_type: "REGULAR", sequence: 3, total_cycles: 0 });
    expect(firstPaidCycleSequence("premium")).toBe(first!.sequence);
  });

  it("never exceeds PayPal's limit: one REGULAR cycle and at most two TRIAL cycles", () => {
    // PayPal's billing_cycle_list: "A plan can have at most two trial cycles
    // and only one regular cycle." Every plan this deploy could create is
    // checked, and a clone with trialDays: 0 is checked by the widened view
    // below, because a plan PayPal refuses is every checkout returning no-plan.
    for (const { tier, interval } of PAID_PLANS) {
      const bc = planRequestBody(tier, interval, "PROD-1").billing_cycles;
      const regular = bc.filter((c) => c.tenure_type === "REGULAR");
      const trial = bc.filter((c) => c.tenure_type === "TRIAL");
      expect(regular, `${tier}/${interval}`).toHaveLength(1);
      expect(trial.length, `${tier}/${interval}`).toBeLessThanOrEqual(2);
      // The open-ended cycle is the regular one and the only one.
      expect(bc.filter((c) => c.total_cycles === 0)).toEqual(regular);
      // Sequences are 1..n, contiguous, and the regular cycle comes last.
      expect(bc.map((c) => c.sequence)).toEqual(bc.map((_, i) => i + 1));
      expect(bc[bc.length - 1]!.tenure_type).toBe("REGULAR");
      // The coupon override targets a cycle that exists and is not the
      // open-ended one.
      const target = bc.find((c) => c.sequence === firstPaidCycleSequence(tier));
      expect(target).toMatchObject({ tenure_type: "TRIAL", total_cycles: 1 });
    }
  });

  it("holds the limit for a tier with no free trial as well", () => {
    // The shape when trialDays is 0: priced TRIAL (seq 1) then REGULAR (seq 2).
    const trialDays: number = siteConfig.tiers.essential.trialDays;
    const bc = planRequestBody("essential", "monthly", "PROD-1").billing_cycles;
    const expected = trialDays > 0 ? ["TRIAL", "TRIAL", "REGULAR"] : ["TRIAL", "REGULAR"];
    expect(bc.map((c) => c.tenure_type)).toEqual(expected);
    expect(bc.filter((c) => c.tenure_type === "REGULAR")).toHaveLength(1);
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
    // The first cycle is a TRIAL either way — free when there are trial
    // days, priced (the first payment) when there are none.
    expect(cyclesForEssential[0]!.tenure_type).toBe("TRIAL");
    expect(cyclesForEssential[0]!.pricing_scheme.fixed_price.value).toBe(
      trialDays > 0 ? "0.00" : siteConfig.tiers.essential.priceAnnual.toFixed(2),
    );
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
