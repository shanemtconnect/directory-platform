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
 * recorded (so a redelivery never gets here). The transitions:
 *
 *   confirm — ACTIVATED, UPDATED (status ACTIVE). The row is active. The
 *             payload's `quantity` is the ONLY evidence PayPal agreed to bill
 *             something: with it, `quantity` is written, and pending bids and
 *             raises are confirmed if — and only if — it covers what was
 *             asked (`requested_quantity`). Without it, nothing is confirmed
 *             and `quantity` is left alone. Never a fallback to what we asked
 *             for (C1).
 *   renew   — PAYMENT.SALE.COMPLETED. Still billing; period end moves. It
 *             carries no quantity and confirms nothing.
 *   lapse   — CANCELLED, SUSPENDED, EXPIRED. Every bid the listing holds is
 *             cancelled; the spots re-rank; the others' quantities follow. A
 *             SUSPENDED for a row WE paused is our own doing and is ignored.
 *   past-due — PAYMENT.FAILED. Noted; PayPal retries and SUSPENDED is the
 *             terminal event. Nothing featured moves on a first failure.
 *
 * A confirm for a row that is already cancelled, expired or suspended is
 * ignored and logged (I7): PayPal delivers out of order, and a late
 * ACTIVATED must not revive a subscription PayPal has closed.
 *
 * `listings.tier` is not touched anywhere in this file.
 */

export type FeaturedWebhookOutcome =
  | { readonly outcome: "unknown-subscription" }
  | { readonly outcome: "ignored"; readonly reason: string }
  | {
      readonly outcome: "applied";
      readonly action: "confirm" | "renew" | "lapse" | "past-due";
      readonly paths: string[];
    };

const LAPSE: Record<string, FeaturedSubscriptionStatus> = {
  "BILLING.SUBSCRIPTION.CANCELLED": "cancelled",
  "BILLING.SUBSCRIPTION.SUSPENDED": "suspended",
  "BILLING.SUBSCRIPTION.EXPIRED": "expired",
};

const CLOSED: readonly FeaturedSubscriptionStatus[] = ["cancelled", "expired", "suspended"];

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
      return confirm(tx, sub, event, deps);

    case "BILLING.SUBSCRIPTION.UPDATED":
      if (event.resource.status !== "ACTIVE") return { outcome: "ignored", reason: "update is not active" };
      return confirm(tx, sub, event, deps);

    case "PAYMENT.SALE.COMPLETED":
      return renew(tx, sub, event);

    case "BILLING.SUBSCRIPTION.SUSPENDED":
      if (sub.status === "paused") {
        // Our own suspend, echoed back. Nothing to lapse.
        return { outcome: "ignored", reason: "suspended by this site (paused)" };
      }
      return lapse(tx, sub, "suspended", event.id, deps);

    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
      return lapse(tx, sub, LAPSE[event.type]!, event.id, deps);

    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
      if (CLOSED.includes(sub.status)) return { outcome: "ignored", reason: `row is ${sub.status}` };
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
  if (CLOSED.includes(sub.status)) {
    console.warn(
      `[spots] ignoring ${event.type} ${event.id} for featured subscription ${sub.id}: row is ${sub.status}`,
    );
    return { outcome: "ignored", reason: `row is ${sub.status}` };
  }

  const quantity = parseQuantity(event.resource.quantity);
  const covers = quantity !== null && quantity >= sub.requestedQuantity;
  await updateFeaturedSubscription(
    tx,
    viewer,
    sub.id,
    {
      status: "active",
      pausedAt: null,
      currentPeriodEnd: nextBillingTime(event) ?? sub.currentPeriodEnd,
      ...(quantity === null ? {} : { quantity }),
      ...(covers ? { reviseRequestedAt: null, approveUrl: null } : {}),
    },
    {
      action: "spots.confirmed",
      meta: { eventId: event.id, listingId: sub.listingId, eventType: event.type, quantity, covers },
    },
  );

  // Pending bids and raises become real only on evidence that PayPal agreed
  // to the quantity that covers them. Otherwise they wait: the sync keeps
  // re-requesting, and expires them after a day.
  const touched = covers ? await confirmListingBids(tx, viewer, sub.listingId) : [];
  const held = (await listingBidsForSystem(tx, viewer, sub.listingId)).map((b) => b.spotId);
  const settled = await settleSpots(tx, [...touched, ...held], deps);
  return { outcome: "applied", action: "confirm", paths: settled.paths };
}

async function renew(tx: TestDb, sub: FeaturedSubscription, event: PayPalEvent): Promise<FeaturedWebhookOutcome> {
  if (sub.status !== "active" && sub.status !== "past_due") {
    return { outcome: "ignored", reason: `sale for a ${sub.status} row` };
  }
  await updateFeaturedSubscription(
    tx,
    SPOTS_SYSTEM_VIEWER,
    sub.id,
    { status: "active", currentPeriodEnd: nextBillingTime(event) ?? sub.currentPeriodEnd },
    { action: "spots.renewed", meta: { eventId: event.id, listingId: sub.listingId } },
  );
  return { outcome: "applied", action: "renew", paths: [] };
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
    { status, reviseRequestedAt: null, approveUrl: null, pausedAt: null },
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
 * hourly sync (webhook never arrived) both go through here. The GET's
 * `quantity` is the same evidence a webhook's is; a view without one
 * confirms nothing. A provider that cannot be reached changes nothing.
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
      ...(typeof view.quantity === "number" ? { quantity: String(view.quantity) } : {}),
      billing_info: { next_billing_time: view.nextBillingTime },
    },
  }) as PayPalEvent;

  const out = await processFeaturedEvent(tx, { event, client: input.client, env: input.env });
  if (out.outcome !== "applied") return { outcome: "pending", status: view.status };
  return { outcome: "applied", action: out.action, paths: out.paths };
}
