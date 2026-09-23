import type { TierName } from "@/config/types";
import type { Interval } from "@/lib/pricing";
import { tierForPlanId, trialDaysFor } from "./plans";

/**
 * The webhook state machine, as a pure function.
 *
 * Everything a PayPal event does to our data is decided here and written by
 * `lib/db/queries/billing.ts`. Splitting them is what makes every transition —
 * including the ones that take a paid tier away — checkable against recorded
 * payloads with no database and no network.
 *
 * Two rules constrain every branch:
 *
 *  - A payment never grants the Verified badge (global constraint 30).
 *    Activation OPENS a verification check; `claim_status` only reaches
 *    'verified' when that check passes and a subscription is active. The
 *    reverse is allowed and required: a lapse drops 'verified' to 'claimed'.
 *  - A tier is never invented. If this deploy does not recognise the plan id
 *    on the event, the subscription keeps the tier its own row already says,
 *    rather than being assigned the more expensive guess.
 */

export type SubscriptionStatus =
  | "approval_pending"
  | "active"
  | "past_due"
  | "cancelled"
  | "suspended"
  | "expired";

export interface PayPalEvent {
  readonly id: string;
  readonly type: string;
  readonly resource: Record<string, unknown>;
  readonly createTime: Date | null;
}

/** What the subscriptions row (and its listing) says before the event lands. */
export interface CurrentSubscription {
  readonly id: string;
  readonly listingId: string;
  readonly tier: TierName;
  readonly interval: Interval;
  readonly status: string;
  readonly currentPeriodEnd: Date | null;
  readonly trialEndsAt: Date | null;
  /** Set by the owner's own cancel request; carried until the row lapses. */
  readonly cancelAtPeriodEnd: boolean;
}

export interface Effect {
  readonly action: "activate" | "update" | "renew" | "cancel" | "lapse" | "past-due";
  readonly status: SubscriptionStatus;
  readonly tier: TierName;
  readonly interval: Interval;
  readonly providerPlanId: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly trialEndsAt: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  /** What `listings.tier` should be afterwards. The ONLY writer of that column. */
  readonly listingTier: TierName;
  /** `claim_status` 'verified' -> 'claimed'. Never the other way round. */
  readonly dropVerified: boolean;
  readonly openVerificationCheck: boolean;
}

export type Decision = Effect | { readonly action: "ignore"; readonly reason: string };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function date(v: unknown): Date | null {
  const s = str(v);
  if (s === null) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseEvent(raw: unknown): PayPalEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  const type = str(o.event_type);
  if (id === null || type === null) return null;
  const resource =
    typeof o.resource === "object" && o.resource !== null
      ? (o.resource as Record<string, unknown>)
      : {};
  return { id, type, resource, createTime: date(o.create_time) };
}

/**
 * A subscription event names the subscription; a sale names the billing
 * agreement, which is the same id. Nothing else is matched, so a stray event
 * type cannot be pointed at a subscription row.
 */
export function providerSubscriptionIdFor(event: PayPalEvent): string | null {
  if (event.type === "PAYMENT.SALE.COMPLETED") {
    return str(event.resource.billing_agreement_id);
  }
  if (event.type.startsWith("BILLING.SUBSCRIPTION.")) return str(event.resource.id);
  return null;
}

/** Our own subscriptions row id, round-tripped through PayPal's `custom_id`. */
export function customIdFor(event: PayPalEvent): string | null {
  return str(event.resource.custom_id);
}

function nextBillingTime(event: PayPalEvent): Date | null {
  const info = event.resource.billing_info;
  if (typeof info !== "object" || info === null) return null;
  return date((info as Record<string, unknown>).next_billing_time);
}

export function addInterval(from: Date, interval: Interval): Date {
  const d = new Date(from);
  if (interval === "annual") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

interface DecideOpts {
  readonly env: Record<string, string | undefined>;
  readonly at: Date;
  /**
   * Trial length per tier. Defaults to the config; injectable so the
   * no-trial path can be proved on a deploy whose config has trials.
   */
  readonly trialDays?: (tier: TierName) => number;
}

const DAY_MS = 86_400_000;

/**
 * How close to the stored period end a sale has to land to count as the
 * renewal of that period rather than the payment FOR it. PayPal's own retry
 * window is three days, so a first-payment webhook redelivered late still
 * falls on the right side.
 */
const RENEWAL_WINDOW_MS = 3 * DAY_MS;

/** Plan id -> tier, or the row's own tier. Never a guess at a higher one. */
function resolvePlan(
  event: PayPalEvent,
  current: CurrentSubscription,
  env: Record<string, string | undefined>,
): { tier: TierName; interval: Interval; planId: string | null } {
  const planId = str(event.resource.plan_id);
  const mapped = tierForPlanId(planId, env);
  if (mapped === null) {
    if (planId !== null) {
      console.warn(
        `[billing] plan ${planId} is not one this deploy knows — keeping tier ${current.tier}`,
      );
    }
    return { tier: current.tier, interval: current.interval, planId };
  }
  return { tier: mapped.tier, interval: mapped.interval, planId };
}

export function decide(
  event: PayPalEvent,
  current: CurrentSubscription,
  opts: DecideOpts,
): Decision {
  const { tier, interval, planId } = resolvePlan(event, current, opts.env);
  const trialDays = (opts.trialDays ?? trialDaysFor)(tier);
  const base = {
    tier,
    interval,
    providerPlanId: planId,
    trialEndsAt: current.trialEndsAt,
    // The owner's cancel request is written to the row BEFORE PayPal's
    // CANCELLED event lands. An UPDATED, PAYMENT.FAILED or SALE arriving in
    // between must not flip it back and hide the cancellation.
    cancelAtPeriodEnd: current.cancelAtPeriodEnd,
    dropVerified: false,
    openVerificationCheck: false,
  } as const;

  switch (event.type) {
    case "BILLING.SUBSCRIPTION.ACTIVATED": {
      const periodEnd = nextBillingTime(event) ?? current.currentPeriodEnd;
      // PayPal's first next_billing_time IS the end of the free trial when the
      // plan has one, so that date is both the period end and the trial end.
      // A tier with no trial is charged at activation: nothing ends, and the
      // billing page must not announce a trial that never existed.
      const trialEndsAt =
        current.trialEndsAt ??
        (trialDays > 0 && current.status === "approval_pending" ? periodEnd : null);
      return {
        ...base,
        action: "activate",
        status: "active",
        currentPeriodEnd: periodEnd,
        trialEndsAt,
        // A fresh activation is not cancelling, whatever the row said before.
        cancelAtPeriodEnd: false,
        listingTier: tier,
        // Only on the first activation. The query refuses to open a second
        // check for a listing that already has one.
        openVerificationCheck: true,
      };
    }

    case "BILLING.SUBSCRIPTION.UPDATED": {
      const live = str(event.resource.status) === "ACTIVE";
      return {
        ...base,
        action: "update",
        status: live ? "active" : (current.status as SubscriptionStatus),
        currentPeriodEnd: nextBillingTime(event) ?? current.currentPeriodEnd,
        listingTier: live ? tier : current.tier,
      };
    }

    case "BILLING.SUBSCRIPTION.CANCELLED": {
      // A customer who cancels in month two of a year they have paid for keeps
      // what they bought until the period ends. The sync job performs the lapse
      // on the day, so nothing here takes a paid tier away early.
      const periodEnd = current.currentPeriodEnd;
      const stillPaidFor = periodEnd !== null && periodEnd.getTime() > opts.at.getTime();
      return {
        ...base,
        action: "cancel",
        status: "cancelled",
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true,
        listingTier: stillPaidFor ? current.tier : "free",
        dropVerified: !stillPaidFor,
      };
    }

    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.EXPIRED": {
      const status: SubscriptionStatus =
        event.type === "BILLING.SUBSCRIPTION.SUSPENDED" ? "suspended" : "expired";
      return {
        ...base,
        action: "lapse",
        status,
        currentPeriodEnd: current.currentPeriodEnd,
        listingTier: "free",
        dropVerified: true,
      };
    }

    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
      // PayPal retries on its own schedule and sends SUSPENDED when it gives
      // up. Dropping the tier on the first failure would punish a customer for
      // an expired card that their bank reissues the same week.
      return {
        ...base,
        action: "past-due",
        status: "past_due",
        currentPeriodEnd: nextBillingTime(event) ?? current.currentPeriodEnd,
        listingTier: current.tier,
      };
    }

    case "PAYMENT.SALE.COMPLETED": {
      // Idempotent by construction: the period end is derived from what we
      // already know, never blindly extended.
      //
      //   1. A sale that carries next_billing_time says exactly when the next
      //      one is due; that wins.
      //   2. A sale that lands while the stored period still has more than
      //      the renewal window to run is the payment FOR that period — the
      //      first charge of a no-trial plan, whose ACTIVATED already set the
      //      end — and moves nothing. Without this the row runs one interval
      //      ahead for ever.
      //   3. Otherwise it is the renewal, and the period is extended by one
      //      interval from where it ends. Extending from `now` instead would
      //      walk the billing date forward by the webhook's own latency on
      //      every renewal.
      //   4. A row stale by more than a whole interval — a renewal webhook
      //      that was never delivered — gets one interval from now, so the
      //      customer is not left lapsed the moment they have paid.
      const stored = current.currentPeriodEnd;
      const known = nextBillingTime(event);
      let currentPeriodEnd: Date;
      if (known !== null) {
        currentPeriodEnd = known;
      } else if (stored !== null && stored.getTime() - opts.at.getTime() > RENEWAL_WINDOW_MS) {
        currentPeriodEnd = stored;
      } else if (stored !== null && addInterval(stored, interval).getTime() > opts.at.getTime()) {
        currentPeriodEnd = addInterval(stored, interval);
      } else {
        currentPeriodEnd = addInterval(opts.at, interval);
      }
      return {
        ...base,
        action: "renew",
        status: "active",
        currentPeriodEnd,
        listingTier: tier,
      };
    }

    default:
      return { action: "ignore", reason: `no handler for ${event.type}` };
  }
}

/** The event types this endpoint acts on. Anything else is logged and 200'd. */
export const HANDLED_EVENTS: readonly string[] = [
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.COMPLETED",
];
