import { siteUrl } from "@/lib/schema/builders";
import { now } from "@/lib/clock";
import {
  applyEffect,
  attachProviderSubscription,
  createPendingSubscription,
  listingForCheckout,
  liveSubscriptionForListing,
  subscriptionForEvent,
} from "@/lib/db/queries/billing";
import { attachRedemptionSubscription, redeemCoupon } from "@/lib/db/queries/coupons";
import type { TierName } from "@/config/types";
import type { Interval } from "@/lib/pricing";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";
import { applyDiscount, type CouponRejection } from "./coupons";
import { firstPaidCycleSequence, planAmount, planIdFor } from "./plans";
import type { PayPalClient, PlanOverride } from "./paypal";
import { decide, parseEvent, type PayPalEvent } from "./webhooks";

/**
 * Starting a subscription, and reconciling one after the fact.
 *
 * Both take the PayPal client as an argument rather than reaching for a
 * module-level one: no credentials exist in development, so every path here is
 * exercised against a fake, and "PayPal is not configured" is a first-class
 * outcome rather than a crash.
 */

const WORKER: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };

export interface StartCheckoutInput {
  readonly client: PayPalClient | null;
  readonly env?: Record<string, string | undefined>;
  readonly viewer: Viewer;
  readonly profileId: string;
  readonly listingId: string;
  readonly tier: TierName;
  readonly interval: Interval;
  readonly couponCode: string | null;
  readonly ip: string | null;
  readonly subscriberEmail?: string | null;
}

export type StartCheckoutResult =
  | { outcome: "not-configured" }
  | { outcome: "not-owner" }
  | { outcome: "already-subscribed"; subscriptionId: string }
  | { outcome: "no-plan" }
  | { outcome: "coupon-rejected"; reason: CouponRejection }
  | { outcome: "approval"; subscriptionId: string; approveUrl: string | null };

export const CHECKOUT_RETURN_PATH = "/checkout/return";
export const CHECKOUT_CANCELLED_PATH = "/checkout/cancelled";

/**
 * Caller supplies the transaction, and the PayPal call happens INSIDE it.
 *
 * That is the point: the coupon row is locked from the moment it is read until
 * the subscription PayPal created has been written down. A create that fails
 * rolls the redemption back with it, so a single-use code is never burned by a
 * checkout that never happened.
 *
 * The redemption IS counted before the buyer approves, which over-counts an
 * abandoned checkout. That is the deliberate direction to be wrong in: the
 * alternative — counting on the activation webhook — cannot be locked against
 * a second concurrent checkout, and a `max_redemptions: 1` code that two
 * people both get is a discount we did not agree to give.
 */
export async function startCheckout(
  tx: TestDb,
  input: StartCheckoutInput,
): Promise<StartCheckoutResult> {
  if (input.client === null) return { outcome: "not-configured" };
  const env = input.env ?? process.env;

  const listing = await listingForCheckout(tx, input.viewer, {
    listingId: input.listingId,
    profileId: input.profileId,
  });
  if (listing === null) return { outcome: "not-owner" };

  // Under the row lock listingForCheckout just took: an owner on Essential
  // choosing Premium, or a double-clicked submit, must not create a second
  // PayPal subscription for a listing that already has one billing.
  const live = await liveSubscriptionForListing(tx, input.viewer, {
    listingId: input.listingId,
    profileId: input.profileId,
  });
  if (live !== null) return { outcome: "already-subscribed", subscriptionId: live.id };

  const planId = planIdFor(input.tier, input.interval, env);
  if (planId === null) return { outcome: "no-plan" };

  let planOverride: PlanOverride | null = null;
  let couponCode: string | null = null;
  let redemptionId: string | null = null;

  if (input.couponCode !== null && input.couponCode.trim() !== "") {
    const redeemed = await redeemCoupon(tx, input.viewer, {
      code: input.couponCode,
      tier: input.tier,
      interval: input.interval,
      profileId: input.profileId,
      listingId: input.listingId,
    });
    if (redeemed.outcome === "rejected") {
      return { outcome: "coupon-rejected", reason: redeemed.reason };
    }
    couponCode = redeemed.coupon.code;
    redemptionId = redeemed.redemptionId;
    planOverride = {
      billing_cycles: [
        {
          sequence: firstPaidCycleSequence(input.tier),
          pricing_scheme: {
            fixed_price: applyDiscount(planAmount(input.tier, input.interval), redeemed.coupon),
          },
        },
      ],
    };
  }

  const subscriptionId = await createPendingSubscription(tx, input.viewer, {
    listingId: input.listingId,
    profileId: input.profileId,
    tier: input.tier,
    interval: input.interval,
    providerPlanId: planId,
    ip: input.ip,
    couponCode,
  });
  if (redemptionId !== null) {
    // The redemption was taken before the row existed (a rejected code must
    // leave no pending row); now the row exists, point the redemption at it.
    await attachRedemptionSubscription(tx, input.viewer, { redemptionId, subscriptionId });
  }

  // Deliberately not wrapped: a PayPal failure THROWS, the caller's
  // transaction rolls back, and there is no pending row and no burned coupon
  // for a support ticket to untangle afterwards.
  const created = await input.client.createSubscription({
    planId,
    customId: subscriptionId,
    returnUrl: siteUrl(CHECKOUT_RETURN_PATH),
    cancelUrl: siteUrl(CHECKOUT_CANCELLED_PATH),
    subscriberEmail: input.subscriberEmail ?? null,
    planOverride,
  });

  await attachProviderSubscription(tx, input.viewer, subscriptionId, created.id);
  return { outcome: "approval", subscriptionId, approveUrl: created.approveUrl };
}

/* --------------------------------------------------------------- reconciling */

export type ReconcileOutcome =
  | { outcome: "not-configured" }
  | { outcome: "unknown-subscription" }
  | { outcome: "not-found" }
  | { outcome: "provider-error"; message: string }
  | { outcome: "pending"; status: string }
  | { outcome: "applied"; action: string };

/**
 * PayPal's subscription status, expressed as the webhook this site would have
 * received. Reusing the state machine rather than writing a second one is what
 * keeps "the webhook was missed" and "the webhook arrived" from drifting apart.
 */
const STATUS_EVENTS: Record<string, string> = {
  ACTIVE: "BILLING.SUBSCRIPTION.ACTIVATED",
  SUSPENDED: "BILLING.SUBSCRIPTION.SUSPENDED",
  CANCELLED: "BILLING.SUBSCRIPTION.CANCELLED",
  EXPIRED: "BILLING.SUBSCRIPTION.EXPIRED",
};

export interface ReconcileInput {
  readonly client: PayPalClient | null;
  readonly env?: Record<string, string | undefined>;
  readonly providerSubscriptionId: string;
}

/**
 * Asks PayPal what it thinks and writes that down.
 *
 * Used by the checkout return page (where the buyer is standing in front of us
 * and the ACTIVATED webhook may be seconds away) and by the hourly sync job
 * (where the webhook was never delivered at all). A provider that cannot be
 * reached changes NOTHING: a network error must never grant a year of a paid
 * tier, and it must never take one away either.
 */
export async function reconcileSubscription(
  tx: TestDb,
  input: ReconcileInput,
): Promise<ReconcileOutcome> {
  if (input.client === null) return { outcome: "not-configured" };

  const sub = await subscriptionForEvent(tx, WORKER, {
    providerSubscriptionId: input.providerSubscriptionId,
    customId: null,
  });
  if (sub === null) return { outcome: "unknown-subscription" };

  let view;
  try {
    view = await input.client.getSubscription(input.providerSubscriptionId);
  } catch (e) {
    return { outcome: "provider-error", message: e instanceof Error ? e.message : String(e) };
  }
  if (view === null) return { outcome: "not-found" };

  const eventType = STATUS_EVENTS[view.status];
  if (eventType === undefined) return { outcome: "pending", status: view.status };

  const at = now();
  const synthetic: unknown = {
    // Never recorded in processed_events: this is our question, not PayPal's
    // delivery, and it must not consume the id of a real event.
    id: `reconcile:${input.providerSubscriptionId}:${at.toISOString()}`,
    event_type: eventType,
    create_time: at.toISOString(),
    resource: {
      id: view.id,
      plan_id: view.planId,
      status: view.status,
      billing_info: { next_billing_time: view.nextBillingTime },
    },
  };
  const event = parseEvent(synthetic) as PayPalEvent;

  const effect = decide(event, sub, { env: input.env ?? process.env, at });
  if (effect.action === "ignore") return { outcome: "pending", status: view.status };

  await applyEffect(tx, WORKER, sub, effect, { eventId: event.id });
  return { outcome: "applied", action: effect.action };
}
