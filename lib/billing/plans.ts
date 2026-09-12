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
