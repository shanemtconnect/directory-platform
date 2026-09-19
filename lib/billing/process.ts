import { now } from "@/lib/clock";
import {
  applyEffect,
  recordProcessedEvent,
  subscriptionForEvent,
  type AppliedEffect,
} from "@/lib/db/queries/billing";
import type { TestDb } from "@/lib/db/types";
import type { Viewer } from "@/lib/db/viewer";
import type { PayPalClient } from "./paypal";
import { customIdFor, decide, HANDLED_EVENTS, parseEvent, providerSubscriptionIdFor } from "./webhooks";

/**
 * One PayPal delivery, from raw body to applied transition.
 *
 * Lives outside the route handler so the whole thing — signature failure,
 * redelivery, an event for a subscription that is not ours — can be tested
 * against recorded payloads with a fake client, which is the only way to test
 * it at all when no PayPal credentials exist in development.
 *
 * The status codes are chosen for what PayPal DOES with them:
 *   503 — not configured. PayPal retries, so nothing is lost while the keys
 *         are still being set up.
 *   400 — unparseable. Retrying will not help; do not make PayPal try.
 *   401 — unverified signature. Never written, never acted on.
 *   200 — everything else, including events we ignore. An endpoint that 500s
 *         on an event type it does not handle gets itself disabled by PayPal.
 */

/**
 * The authority billing's own machinery acts with — the webhook endpoint and
 * the reconcile that the return page and the sync job share.
 *
 * Declared here rather than imported from `worker/viewer.ts`: that module's
 * whole point is that request-path code must not be able to reach a ready-made
 * admin viewer, and a route handler is request-path code. This one is exported
 * for `lib/billing/` only; it applies what PayPal reports and nothing else.
 * The nil UUID can never match a row's owner_id.
 */
export const BILLING_SYSTEM_VIEWER: Viewer = {
  role: "admin",
  userId: "00000000-0000-0000-0000-000000000000",
};
const WEBHOOK_VIEWER = BILLING_SYSTEM_VIEWER;

export type WebhookOutcome =
  | "not-configured"
  | "bad-request"
  | "unverified"
  | "duplicate"
  | "ignored"
  | "unknown-subscription"
  | "applied";

export interface WebhookResult {
  readonly status: 200 | 400 | 401 | 503;
  readonly outcome: WebhookOutcome;
  readonly detail?: string;
  /** Paths the route handler must revalidate. Empty unless something changed. */
  readonly revalidate?: AppliedEffect;
}

export interface WebhookRequest {
  readonly raw: string;
  readonly headers: Record<string, string | null | undefined>;
  readonly client: PayPalClient | null;
  readonly env?: Record<string, string | undefined>;
}

export async function processPayPalWebhook(
  tx: TestDb,
  req: WebhookRequest,
): Promise<WebhookResult> {
  if (req.client === null) {
    console.warn("[billing] a webhook arrived but PayPal is not configured");
    return { status: 503, outcome: "not-configured" };
  }

  let body: unknown;
  try {
    body = JSON.parse(req.raw);
  } catch {
    return { status: 400, outcome: "bad-request", detail: "body is not JSON" };
  }

  const event = parseEvent(body);
  if (event === null) return { status: 400, outcome: "bad-request", detail: "not an event" };

  // Verification FIRST, before a single row is written. The RAW body goes to
  // PayPal, not the parsed one: the signature is over the bytes it sent, and
  // the parse above only proves those bytes are a document worth asking about.
  const verified = await req.client.verifyWebhookSignature(req.headers, req.raw);
  if (!verified) {
    console.error(`[billing] rejected unverified webhook ${event.id} (${event.type})`);
    return { status: 401, outcome: "unverified" };
  }

  // The unique index is the idempotency gate: if this insert loses, the event
  // has already been applied and must not be applied again.
  const fresh = await recordProcessedEvent(tx, WEBHOOK_VIEWER, {
    eventId: event.id,
    payload: body,
  });
  if (!fresh) return { status: 200, outcome: "duplicate" };

  if (!HANDLED_EVENTS.includes(event.type)) {
    // Recorded above on purpose: a redelivery of something we ignore should
    // cost a unique-index conflict, not another decision.
    console.log(`[billing] ignoring ${event.type} (${event.id})`);
    return { status: 200, outcome: "ignored", detail: event.type };
  }

  const sub = await subscriptionForEvent(tx, WEBHOOK_VIEWER, {
    providerSubscriptionId: providerSubscriptionIdFor(event),
    customId: customIdFor(event),
  });
  if (sub === null) {
    // Another site sharing the PayPal account, or a subscription created
    // before this database existed. Not an error, and not ours to act on.
    console.warn(`[billing] ${event.type} names a subscription this site does not hold`);
    return { status: 200, outcome: "unknown-subscription" };
  }

  const effect = decide(event, sub, { env: req.env ?? process.env, at: now() });
  if (effect.action === "ignore") {
    return { status: 200, outcome: "ignored", detail: effect.reason };
  }

  const revalidate = await applyEffect(tx, WEBHOOK_VIEWER, sub, effect, { eventId: event.id });
  return { status: 200, outcome: "applied", detail: effect.action, revalidate };
}
