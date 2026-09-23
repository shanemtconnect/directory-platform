import { siteConfig } from "@/config/site.config";
import { now } from "@/lib/clock";
import { siteUrl } from "@/lib/schema/builders";
import type { PlanRequestBody } from "@/lib/billing/plans";
import type { PayPalClient } from "@/lib/billing/paypal";
import { addInterval, type PayPalEvent } from "@/lib/billing/webhooks";
import {
  CHECKOUT_BILLING,
  advertiserCampaignForCheckout,
  applySponsorBillingEffect,
  attachSponsorSubscription,
  sponsorCampaignForBilling,
  type SponsorBillingRow,
} from "@/lib/db/queries/ads";
import { writeAuditAs } from "@/lib/db/queries/audit";
import { BILLING_SYSTEM_VIEWER } from "@/lib/billing/process";
import type { SponsorBillingStatus } from "@/lib/db/schema";
import type { TestDb } from "@/lib/db/types";
import type { Viewer } from "@/lib/db/viewer";

/**
 * The sponsor product on PayPal: one monthly plan per site, priced from
 * `siteConfig.ads.monthlyPrice`, created by `scripts/paypal-setup.ts` and
 * named to the app by `PAYPAL_PLAN_SPONSOR_MONTHLY`. Deliberately NOT part
 * of the boot-time billing group: a site can run listing billing without
 * ever selling a sponsor slot, and a missing plan id only means the
 * self-serve form takes the campaign without a card.
 */
export const SPONSOR_PLAN_ENV = "PAYPAL_PLAN_SPONSOR_MONTHLY";

type Env = Record<string, string | undefined>;

export function sponsorPlanId(env: Env = process.env): string | null {
  const id = (env[SPONSOR_PLAN_ENV] ?? "").trim();
  return id === "" ? null : id;
}

export function sponsorPlanName(): string {
  return `${siteConfig.shortName} Sponsor (monthly)`;
}

export function sponsorPlanAmount(): { value: string; currency_code: string } {
  const minor = Math.round(siteConfig.ads.monthlyPrice * 100);
  return { value: (minor / 100).toFixed(2), currency_code: siteConfig.currency };
}

/** No trial, one open-ended REGULAR cycle: a sponsor slot is paid from day one. */
export function sponsorPlanRequestBody(productId: string): PlanRequestBody {
  return {
    product_id: productId,
    name: sponsorPlanName(),
    description: "Sponsor rail placement, billed monthly",
    status: "ACTIVE",
    billing_cycles: [
      {
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        tenure_type: "REGULAR",
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: sponsorPlanAmount() },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: "CONTINUE",
      payment_failure_threshold: 3,
    },
  };
}

export const SPONSOR_RETURN_PATH = "/advertise/sponsor/return";
export const SPONSOR_CANCELLED_PATH = "/advertise/sponsor?cancelled=1";

export interface StartSponsorCheckoutInput {
  readonly client: PayPalClient | null;
  readonly env?: Env;
  readonly viewer: Viewer;
  readonly profileId: string;
  readonly campaignId: string;
  readonly subscriberEmail?: string | null;
}

export type StartSponsorCheckoutResult =
  | { outcome: "not-configured" }
  | { outcome: "not-owner" }
  | { outcome: "not-eligible" }
  | { outcome: "approval"; approveUrl: string | null };

/**
 * Creates the PayPal subscription for a freshly submitted campaign and
 * records its id. `custom_id` is the campaign id, so an ACTIVATED webhook
 * that beats the redirect still finds its row.
 */
export async function startSponsorCheckout(
  tx: TestDb,
  input: StartSponsorCheckoutInput,
): Promise<StartSponsorCheckoutResult> {
  const planId = sponsorPlanId(input.env ?? process.env);
  if (input.client === null || planId === null) return { outcome: "not-configured" };
  // Ownership and eligibility BEFORE the PayPal call: a stranger's id must not
  // leave an orphaned subscription behind, and a paid or finished campaign
  // must not get a second one.
  const campaign = await advertiserCampaignForCheckout(tx, input.viewer, {
    campaignId: input.campaignId,
    profileId: input.profileId,
  });
  if (campaign === null) return { outcome: "not-owner" };
  if (
    campaign.status === "ended" ||
    campaign.status === "rejected" ||
    !CHECKOUT_BILLING.includes(campaign.billingStatus)
  ) {
    return { outcome: "not-eligible" };
  }
  const created = await input.client.createSubscription({
    planId,
    customId: input.campaignId,
    returnUrl: siteUrl(SPONSOR_RETURN_PATH),
    cancelUrl: siteUrl(SPONSOR_CANCELLED_PATH),
    subscriberEmail: input.subscriberEmail ?? null,
    planOverride: null,
  });
  const attached = await attachSponsorSubscription(tx, input.viewer, {
    campaignId: input.campaignId,
    profileId: input.profileId,
    providerSubscriptionId: created.id,
  });
  if (!attached) return { outcome: "not-owner" };
  return { outcome: "approval", approveUrl: created.approveUrl };
}

/* ------------------------------------------------------------ the webhook */

export interface SponsorEffect {
  readonly action: "activate" | "renew" | "update" | "past-due" | "cancel" | "lapse";
  readonly billingStatus: SponsorBillingStatus;
  readonly currentPeriodEnd: Date | null;
  readonly endsAt: Date | null | undefined;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function nextBillingTime(event: PayPalEvent): Date | null {
  const info = event.resource.billing_info;
  if (typeof info !== "object" || info === null) return null;
  const raw = str((info as Record<string, unknown>).next_billing_time);
  if (raw === null) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The state machine, pure. Simpler than a listing's because there is no tier
 * to grant: a paid campaign shows, an unpaid one does not. Cancelling keeps
 * the campaign on the rails until the paid period runs out (`ends_at` =
 * period end); suspension and expiry take it down at once.
 */
export function decideSponsor(
  event: PayPalEvent,
  current: SponsorBillingRow,
  at: Date,
): SponsorEffect | { action: "ignore"; reason: string } {
  switch (event.type) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
      return {
        action: "activate",
        billingStatus: "active",
        currentPeriodEnd: nextBillingTime(event) ?? current.currentPeriodEnd ?? addInterval(at, "monthly"),
        endsAt: null,
      };
    case "BILLING.SUBSCRIPTION.UPDATED": {
      const live = str(event.resource.status) === "ACTIVE";
      return {
        action: "update",
        billingStatus: live ? "active" : current.billingStatus,
        currentPeriodEnd: nextBillingTime(event) ?? current.currentPeriodEnd,
        endsAt: undefined,
      };
    }
    case "PAYMENT.SALE.COMPLETED": {
      const known = nextBillingTime(event);
      const stored = current.currentPeriodEnd;
      const periodEnd =
        known ??
        (stored !== null && stored.getTime() > at.getTime() ? stored : addInterval(stored ?? at, "monthly"));
      return { action: "renew", billingStatus: "active", currentPeriodEnd: periodEnd, endsAt: null };
    }
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
      return {
        action: "past-due",
        billingStatus: "past_due",
        currentPeriodEnd: nextBillingTime(event) ?? current.currentPeriodEnd,
        endsAt: undefined,
      };
    case "BILLING.SUBSCRIPTION.CANCELLED": {
      const periodEnd = current.currentPeriodEnd;
      const stillPaidFor = periodEnd !== null && periodEnd.getTime() > at.getTime();
      return {
        action: "cancel",
        billingStatus: "cancelled",
        currentPeriodEnd: periodEnd,
        endsAt: stillPaidFor ? periodEnd : at,
      };
    }
    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
      return {
        action: "lapse",
        billingStatus: event.type === "BILLING.SUBSCRIPTION.SUSPENDED" ? "suspended" : "expired",
        currentPeriodEnd: current.currentPeriodEnd,
        endsAt: undefined,
      };
    default:
      return { action: "ignore", reason: `no sponsor handler for ${event.type}` };
  }
}

export type SponsorWebhookOutcome = "unknown-subscription" | "ignored" | "applied";

/**
 * Called by `processPayPalWebhook` when the event names no listing
 * subscription. Looks the campaign up by provider id, then by `custom_id`.
 */
export async function applySponsorBillingEvent(
  tx: TestDb,
  viewer: Viewer,
  event: PayPalEvent,
  ids: { providerSubscriptionId: string | null; customId: string | null },
): Promise<{ outcome: SponsorWebhookOutcome; detail?: string }> {
  const current = await sponsorCampaignForBilling(tx, viewer, ids);
  if (current === null) return { outcome: "unknown-subscription" };
  const effect = decideSponsor(event, current, now());
  if (effect.action === "ignore") return { outcome: "ignored", detail: effect.reason };
  await applySponsorBillingEffect(tx, viewer, current.id, {
    action: effect.action,
    billingStatus: effect.billingStatus,
    currentPeriodEnd: effect.currentPeriodEnd,
    endsAt: effect.endsAt,
    eventId: event.id,
    providerSubscriptionId: ids.providerSubscriptionId,
  });
  return { outcome: "applied", detail: effect.action };
}

/* ------------------------------------------------------- after a decision (C1) */

/** Billing states under which a PayPal subscription is still charging or about to. */
export const CANCELLABLE_BILLING: readonly SponsorBillingStatus[] = [
  "approval_pending", "active", "past_due",
];

export interface CancelSponsorInput {
  readonly campaignId: string;
  readonly subscriptionId: string | null;
  readonly billingStatus: SponsorBillingStatus;
  readonly reason: string;
  /** What to key the audit on — the decision's audit row id. */
  readonly ref: string;
}

export type CancelSponsorOutcome = "not-needed" | "not-configured" | "cancelled" | "failed";

/**
 * Runs AFTER the decision has committed, exactly like `cancelSubscriptionAction`
 * does for listings: PayPal first, then our row. Never throws — the campaign
 * is already ended or rejected and that must stand; a PayPal failure is
 * logged and audited (`sponsor.billing` / `cancel-failed`) so somebody can
 * cancel it by hand, and the caller tells the admin.
 */
export async function cancelSponsorSubscription(
  db: TestDb,
  client: PayPalClient | null,
  input: CancelSponsorInput,
): Promise<CancelSponsorOutcome> {
  if (input.subscriptionId === null || !CANCELLABLE_BILLING.includes(input.billingStatus)) {
    return "not-needed";
  }
  if (client === null) {
    console.warn(`[ads] campaign ${input.campaignId} has subscription ${input.subscriptionId} but PayPal is not configured — cancel it by hand`);
    return "not-configured";
  }
  try {
    await client.cancelSubscription(input.subscriptionId, input.reason);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[ads] PayPal cancel failed for campaign ${input.campaignId}:`, message);
    await writeAuditAs(db, null, {
      action: "sponsor.billing",
      entityType: "sponsor_campaign",
      entityId: input.campaignId,
      meta: { action: "cancel-failed", ref: input.ref, subscriptionId: input.subscriptionId, error: message.slice(0, 200) },
    }).catch(() => {});
    return "failed";
  }
  await applySponsorBillingEffect(db, BILLING_SYSTEM_VIEWER, input.campaignId, {
    action: "cancel",
    billingStatus: "cancelled",
    currentPeriodEnd: undefined,
    endsAt: now(),
    eventId: `decision:${input.ref}`,
  });
  return "cancelled";
}
