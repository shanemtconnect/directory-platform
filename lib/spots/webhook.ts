import { now } from "@/lib/clock";
import { parseQuantity, type PayPalClient } from "@/lib/billing/paypal";
import {
  customIdFor,
  parseEvent,
  providerSubscriptionIdFor,
  type PayPalEvent,
} from "@/lib/billing/webhooks";
import {
  cancelListingBids,
  confirmListingBids,
  featuredSubscriptionForEvent,
  listingBidsForSystem,
  updateFeaturedSubscription,
  type FeaturedSubscription,
  type FeaturedSubscriptionStatus,
} from "@/lib/db/queries/spots";
import type { TestDb } from "@/lib/db/types";
import { SPOTS_SYSTEM_VIEWER, settleSpots, type BillingDeps } from "./engine";

/**
 * What a PayPal event does to a FEATURED subscription.
 *
 * Reached from `lib/billing/process.ts` when the event names a subscription
 * the tier table does not hold: signature already verified, event already
 * recorded (so a redelivery never gets here). Three transitions:
 *
 *   confirm — ACTIVATED, UPDATED (status ACTIVE), PAYMENT.SALE.COMPLETED.
 *             The row is active with PayPal's quantity; every pending bid and
 *             pending raise of the listing becomes real; the spots re-rank;
 *             everyone's quantity is recomputed.
 *   lapse   — CANCELLED, SUSPENDED, EXPIRED. Every bid the listing holds is
 *             cancelled; the spots re-rank; the others' quantities follow.
 *   past-due — PAYMENT.FAILED. Noted; PayPal retries and SUSPENDED is the
 *             terminal event. Nothing featured moves on a first failure.
 *
 * `listings.tier` is not touched anywhere in this file.
 */

export type FeaturedWebhookOutcome =
  | { readonly outcome: "unknown-subscription" }
  | { readonly outcome: "ignored"; readonly reason: string }
  | { readonly outcome: "applied"; readonly action: "confirm" | "lapse" | "past-due"; readonly paths: string[] };

const LAPSE: Record<string, FeaturedSubscriptionStatus> = {
  "BILLING.SUBSCRIPTION.CANCELLED": "cancelled",
  "BILLING.SUBSCRIPTION.SUSPENDED": "suspended",
  "BILLING.SUBSCRIPTION.EXPIRED": "expired",
};

function nextBillingTime(event: PayPalEvent): Date | null {
  const info = event.resource.billing_info;
  if (typeof info !== "object" || info === null) return null;
  const raw = (info as Record<string, unknown>).next_billing_time;
  if (typeof raw !== "string") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function processFeaturedEvent(
  tx: TestDb,
  input: { event: PayPalEvent; client: PayPalClient | null; env?: Record<string, string | undefined> },
): Promise<FeaturedWebhookOutcome> {
  const viewer = SPOTS_SYSTEM_VIEWER;
  const { event } = input;
  const sub = await featuredSubscriptionForEvent(tx, viewer, {
    providerSubscriptionId: providerSubscriptionIdFor(event),
    customId: customIdFor(event),
  });
  if (sub === null) return { outcome: "unknown-subscription" };
  const deps: BillingDeps = { client: input.client, env: input.env };

  switch (event.type) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
    case "PAYMENT.SALE.COMPLETED":
      return confirm(tx, sub, event, deps);

    case "BILLING.SUBSCRIPTION.UPDATED":
      if (event.resource.status !== "ACTIVE") return { outcome: "ignored", reason: "update is not active" };
      return confirm(tx, sub, event, deps);

    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
      return lapse(tx, sub, LAPSE[event.type]!, event.id, deps);

    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
      await updateFeaturedSubscription(
        tx,
        viewer,
        sub.id,
        { status: "past_due" },
        { action: "spots.past_due", meta: { eventId: event.id, listingId: sub.listingId } },
      );
      return { outcome: "applied", action: "past-due", paths: [] };

    default:
      return { outcome: "ignored", reason: `no featured handler for ${event.type}` };
  }
}

async function confirm(
  tx: TestDb,
  sub: FeaturedSubscription,
  event: PayPalEvent,
  deps: BillingDeps,
): Promise<FeaturedWebhookOutcome> {
  const viewer = SPOTS_SYSTEM_VIEWER;
  const quantity = parseQuantity(event.resource.quantity) ?? sub.requestedQuantity;
  await updateFeaturedSubscription(
    tx,
    viewer,
    sub.id,
    {
      status: "active",
      quantity,
      reviseRequestedAt: null,
      approveUrl: null,
      currentPeriodEnd: nextBillingTime(event) ?? sub.currentPeriodEnd,
    },
    { action: "spots.confirmed", meta: { eventId: event.id, listingId: sub.listingId, eventType: event.type } },
  );
  const touched = await confirmListingBids(tx, viewer, sub.listingId);
  // Re-rank every spot the listing is in, not only the ones with a pending
  // bid: a confirmation with a lower quantity than requested changes nothing
  // in the ranking, but the sync that follows has to see the whole picture.
  const held = (await listingBidsForSystem(tx, viewer, sub.listingId)).map((b) => b.spotId);
  const settled = await settleSpots(tx, [...touched, ...held], deps);
  return { outcome: "applied", action: "confirm", paths: settled.paths };
}

async function lapse(
  tx: TestDb,
  sub: FeaturedSubscription,
  status: FeaturedSubscriptionStatus,
  eventId: string,
  deps: BillingDeps,
): Promise<FeaturedWebhookOutcome> {
  const viewer = SPOTS_SYSTEM_VIEWER;
  await updateFeaturedSubscription(
    tx,
    viewer,
    sub.id,
    { status, reviseRequestedAt: null, approveUrl: null },
    { action: `spots.${status}`, meta: { eventId, listingId: sub.listingId } },
  );
  const spots = await cancelListingBids(tx, viewer, sub.listingId, { reason: status, eventId });
  const settled = await settleSpots(tx, spots, deps);
  return { outcome: "applied", action: "lapse", paths: settled.paths };
}

/* --------------------------------------------------------------- reconcile */

export type FeaturedReconcileOutcome =
  | { readonly outcome: "not-configured" }
  | { readonly outcome: "unknown-subscription" }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "provider-error"; readonly message: string }
  | { readonly outcome: "pending"; readonly status: string }
  | { readonly outcome: "applied"; readonly action: string; readonly paths: string[] };

const STATUS_EVENTS: Record<string, string> = {
  ACTIVE: "BILLING.SUBSCRIPTION.ACTIVATED",
  SUSPENDED: "BILLING.SUBSCRIPTION.SUSPENDED",
  CANCELLED: "BILLING.SUBSCRIPTION.CANCELLED",
  EXPIRED: "BILLING.SUBSCRIPTION.EXPIRED",
};

/**
 * Asks PayPal and writes down the answer, through the same transitions the
 * webhook uses. The return page (buyer standing in front of us) and the
 * hourly sync (webhook never arrived) both go through here. A provider that
 * cannot be reached changes nothing.
 */
export async function reconcileFeaturedSubscription(
  tx: TestDb,
  input: { client: PayPalClient | null; env?: Record<string, string | undefined>; providerSubscriptionId: string },
): Promise<FeaturedReconcileOutcome> {
  if (input.client === null) return { outcome: "not-configured" };
  const sub = await featuredSubscriptionForEvent(tx, SPOTS_SYSTEM_VIEWER, {
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
  const event = parseEvent({
    // Never recorded in processed_events: our question, not PayPal's delivery.
    id: `reconcile:featured:${input.providerSubscriptionId}:${at.toISOString()}`,
    event_type: eventType,
    create_time: at.toISOString(),
    resource: {
      id: view.id,
      plan_id: view.planId,
      status: view.status,
      quantity: view.quantity ?? null,
      billing_info: { next_billing_time: view.nextBillingTime },
    },
  }) as PayPalEvent;

  const out = await processFeaturedEvent(tx, { event, client: input.client, env: input.env });
  if (out.outcome !== "applied") return { outcome: "pending", status: view.status };
  return { outcome: "applied", action: out.action, paths: out.paths };
}
