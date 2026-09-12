import { siteConfig } from "@/config/site.config";
import type { TierName, TierSpec } from "@/config/types";
import { isFree, priceFor, type Interval } from "@/lib/pricing";

/**
 * The bridge between `config/site.config.ts` and PayPal's plan ids.
 *
 * A PayPal plan is created once, out of band, by `scripts/paypal-setup.ts`;
 * its id then lives in the environment. Nothing here invents a price — the
 * amounts come from the tier specs, so a clone that edits its config and
 * re-runs the setup script gets plans that match its own pricing page.
 *
 * The reverse mapping (plan id -> tier) is deliberately STRICT. Toolkit's
 * version defaulted an unrecognised plan to the higher tier and silently
 * upgraded every cheaper customer; an unknown id here resolves to nothing at
 * all, which is loud and cannot give anything away.
 */

export const INTERVALS: readonly Interval[] = ["monthly", "annual"] as const;

export interface PlanRef {
  readonly tier: TierName;
  readonly interval: Interval;
}

function tierSpec(tier: TierName): TierSpec {
  return siteConfig.tiers[tier];
}

export function isPaidTier(tier: TierName): boolean {
  return !isFree(tierSpec(tier));
}

/** Every billable tier × interval, derived from the config rather than listed. */
export const PAID_PLANS: readonly PlanRef[] = (
  Object.keys(siteConfig.tiers) as TierName[]
)
  .filter(isPaidTier)
  .flatMap((tier) => INTERVALS.map((interval) => ({ tier, interval })));

export function planEnvVar(tier: TierName, interval: Interval): string {
  return `PAYPAL_PLAN_${tier.toUpperCase()}_${interval.toUpperCase()}`;
}

/** The env vars a billing-enabled deploy has to set. */
export const PLAN_ENV_VARS: readonly string[] = PAID_PLANS.map((p) =>
  planEnvVar(p.tier, p.interval),
);

const clean = (v: string | undefined): string => (v ?? "").trim();

export function planIdFor(
  tier: TierName,
  interval: Interval,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isPaidTier(tier)) return null;
  const id = clean(env[planEnvVar(tier, interval)]);
  return id === "" ? null : id;
}

/**
 * Never guesses. An id we did not put in the environment maps to nothing, so a
 * subscription created against a plan this deploy does not know about cannot
 * quietly grant a tier nobody paid for.
 */
export function tierForPlanId(
  planId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): PlanRef | null {
  const wanted = clean(planId ?? undefined);
  if (wanted === "") return null;
  for (const plan of PAID_PLANS) {
    if (planIdFor(plan.tier, plan.interval, env) === wanted) return plan;
  }
  return null;
}

/** Money is compared and carried in minor units. 24.9 * 12 is not 298.8. */
export function minorUnits(amount: number): number {
  return Math.round(amount * 100);
}

export interface PayPalAmount {
  readonly value: string;
  readonly currency_code: string;
}

/**
 * PayPal takes a decimal string. It is produced from the configured price and
 * nothing else — there is no second source of truth for what a plan costs.
 */
export function planAmount(tier: TierName, interval: Interval): PayPalAmount {
  if (!isPaidTier(tier)) {
    throw new Error(`planAmount: ${tier} is free — there is nothing to charge`);
  }
  const minor = minorUnits(priceFor(tierSpec(tier), interval));
  return { value: (minor / 100).toFixed(2), currency_code: siteConfig.currency };
}

/**
 * Which billing cycle a first-cycle coupon discounts.
 *
 * `scripts/paypal-setup.ts` builds every plan with the same shape: an optional
 * free TRIAL cycle, then a REGULAR cycle of exactly one iteration at full
 * price, then an open-ended REGULAR cycle at full price. That middle cycle is
 * the only reason a percentage off the FIRST payment can be expressed as a
 * PayPal plan override at all — overriding a single open-ended cycle would
 * discount every renewal for ever.
 */
export function firstPaidCycleSequence(tier: TierName): number {
  return trialDaysFor(tier) > 0 ? 2 : 1;
}

export function trialDaysFor(tier: TierName): number {
  return tierSpec(tier).trialDays;
}

/**
 * The setup script is idempotent by plan NAME, so this string has to be stable
 * across runs and unique per tier and interval.
 */
export function planNameFor(tier: TierName, interval: Interval): string {
  return `${siteConfig.shortName} ${tierSpec(tier).label} (${interval})`;
}

export function productNameFor(): string {
  return `${siteConfig.name} listing subscription`;
}

/** Parses a URL segment. Anything else is not a plan we sell. */
export function parseTier(raw: string): TierName | null {
  return raw in siteConfig.tiers && isPaidTier(raw as TierName) ? (raw as TierName) : null;
}

export function parseBillingInterval(raw: string): Interval | null {
  return raw === "monthly" || raw === "annual" ? raw : null;
}

/* --------------------------------------------------------------- setup shape */

export interface PlanFrequency {
  readonly interval_unit: "DAY" | "MONTH" | "YEAR";
  readonly interval_count: number;
}

export interface PlanBillingCycle {
  readonly frequency: PlanFrequency;
  readonly tenure_type: "TRIAL" | "REGULAR";
  readonly sequence: number;
  /** 0 means "for ever". Exactly one cycle in a plan may say it. */
  readonly total_cycles: number;
  readonly pricing_scheme: { readonly fixed_price: PayPalAmount };
}

export interface PlanRequestBody {
  readonly product_id: string;
  readonly name: string;
  readonly description: string;
  readonly status: "ACTIVE";
  readonly billing_cycles: readonly PlanBillingCycle[];
  readonly payment_preferences: {
    readonly auto_bill_outstanding: boolean;
    readonly setup_fee_failure_action: "CONTINUE";
    readonly payment_failure_threshold: number;
  };
}

const FREQUENCY: Record<Interval, PlanFrequency> = {
  monthly: { interval_unit: "MONTH", interval_count: 1 },
  annual: { interval_unit: "YEAR", interval_count: 1 },
};

/**
 * The body `scripts/paypal-setup.ts` posts to create one plan.
 *
 * The cycle list has a shape the rest of this codebase depends on:
 *
 *   1. TRIAL, free, one cycle        — only when the tier has trial days.
 *   2. REGULAR, full price, ONE cycle — the cycle a coupon discounts.
 *   3. REGULAR, full price, for ever  — every renewal after that.
 *
 * Two regular cycles rather than one, because PayPal's subscription-level
 * plan override can only rewrite a cycle the plan already has. With a single
 * open-ended cycle, "25% off the first payment" would be 25% off every payment
 * for the life of the subscription. Splitting the first payment into its own
 * finite cycle is what makes a first-cycle discount expressible at all — see
 * `firstPaidCycleSequence`.
 *
 * No `taxes` block: the seller is in Jersey and is not VAT registered, so a
 * tax percentage here would be inventing a charge.
 */
export function planRequestBody(
  tier: TierName,
  interval: Interval,
  productId: string,
): PlanRequestBody {
  const amount = planAmount(tier, interval);
  const trialDays = trialDaysFor(tier);
  const cycles: PlanBillingCycle[] = [];

  if (trialDays > 0) {
    cycles.push({
      frequency: { interval_unit: "DAY", interval_count: trialDays },
      tenure_type: "TRIAL",
      sequence: 1,
      total_cycles: 1,
      pricing_scheme: { fixed_price: { value: "0.00", currency_code: amount.currency_code } },
    });
  }

  const firstPaid = firstPaidCycleSequence(tier);
  cycles.push(
    {
      frequency: FREQUENCY[interval],
      tenure_type: "REGULAR",
      sequence: firstPaid,
      total_cycles: 1,
      pricing_scheme: { fixed_price: amount },
    },
    {
      frequency: FREQUENCY[interval],
      tenure_type: "REGULAR",
      sequence: firstPaid + 1,
      total_cycles: 0,
      pricing_scheme: { fixed_price: amount },
    },
  );

  return {
    product_id: productId,
    name: planNameFor(tier, interval),
    description: `${siteConfig.tiers[tier].label} plan, billed ${interval === "annual" ? "yearly" : "monthly"}`,
    status: "ACTIVE",
    billing_cycles: cycles,
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: "CONTINUE",
      // Three tries, then PayPal suspends and our webhook drops the tier.
      payment_failure_threshold: 3,
    },
  };
}
