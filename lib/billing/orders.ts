import { siteConfig } from "@/config/site.config";
import { siteUrl } from "@/lib/schema/builders";
import {
  jobForOrder,
  markJobPaid,
  providerOrderIdForJob,
  recordJobPaymentMismatch,
  type MarkPaidResult,
} from "@/lib/db/queries/job-board";
import type { TestDb } from "@/lib/db/types";
import type { Viewer } from "@/lib/db/viewer";
import { billingConfigured, createPayPalRequest, type PayPalHttp } from "./paypal";
import type { PayPalEvent } from "./webhooks";

/**
 * One-off payments through PayPal Orders (Task 49).
 *
 * The subscription adapter in ./paypal.ts is the wrong shape for a job post:
 * a post is bought once and never renews, and a subscription for it would be
 * a recurring charge nobody asked for. This is the minimal Orders pair —
 * create with `intent: CAPTURE`, then capture once the buyer has approved —
 * plus the `PAYMENT.CAPTURE.COMPLETED` webhook handled by the same endpoint
 * as everything else, idempotent through `processed_events` like every other
 * event (global constraint 29).
 *
 * Two roads lead to "paid" and both are needed: the return page captures
 * while the buyer is standing there, and the webhook settles the case where
 * the buyer closed the tab after approving. `markJobPaid` locks the row and
 * refuses a second write, so whichever arrives second changes nothing.
 *
 * Same discipline as the rest of the folder: an INTERFACE first, callers
 * take a client, and the tests hand them a fake. Nothing here is reached
 * without credentials, and nothing here ever talks to the real API in a test.
 */

type Env = Record<string, string | undefined>;

export interface CreateOrderInput {
  /** Our own row id. Comes back on the capture as `custom_id`. */
  readonly customId: string;
  readonly description: string;
  readonly returnUrl: string;
  readonly cancelUrl: string;
}

export interface CreatedOrder {
  readonly id: string;
  readonly status: string;
  readonly approveUrl: string | null;
}

export interface CaptureAmount {
  readonly value: string;
  readonly currencyCode: string;
}

export interface CapturedOrder {
  readonly id: string;
  /** 'COMPLETED' when the money moved. Anything else is not paid. */
  readonly status: string;
  readonly captureId: string | null;
  /** What was actually taken. Null when PayPal did not say, which is not "the right amount". */
  readonly amount: CaptureAmount | null;
}

/**
 * Whether a capture is for exactly the configured price in the configured
 * currency. Nothing is marked paid on any other amount: a capture we did not
 * create can carry our row id in `custom_id`, and a price raised in config
 * must not be settled by an order created at the old one.
 */
export function amountMatches(amount: CaptureAmount | null): boolean {
  if (amount === null) return false;
  const expected = jobPostingAmount();
  return (
    Number(amount.value) === Number(expected.value) &&
    amount.currencyCode.toUpperCase() === expected.currency_code.toUpperCase()
  );
}

function readAmount(node: unknown): CaptureAmount | null {
  if (typeof node !== "object" || node === null) return null;
  const o = node as Record<string, unknown>;
  const value = str(o.value);
  const currencyCode = str(o.currency_code);
  return value !== null && currencyCode !== null ? { value, currencyCode } : null;
}

export interface PayPalOrdersClient {
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  captureOrder(orderId: string): Promise<CapturedOrder>;
}

/** The price a non-verified poster pays, as PayPal wants it written. */
export function jobPostingAmount(): { value: string; currency_code: string } {
  return { value: siteConfig.jobs.price.toFixed(2), currency_code: siteConfig.currency };
}

interface Link {
  rel?: string;
  href?: string;
}

function linkHref(links: unknown, rel: string): string | null {
  if (!Array.isArray(links)) return null;
  const hit = (links as Link[]).find((l) => l?.rel === rel);
  return typeof hit?.href === "string" ? hit.href : null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The first capture off an order: purchase_units[0].payments.captures[0]. */
function firstCapture(json: Record<string, unknown>): { id: string | null; amount: CaptureAmount | null } {
  const none = { id: null, amount: null };
  const units = json.purchase_units;
  if (!Array.isArray(units) || units.length === 0) return none;
  const payments = (units[0] as Record<string, unknown>).payments;
  if (typeof payments !== "object" || payments === null) return none;
  const captures = (payments as Record<string, unknown>).captures;
  if (!Array.isArray(captures) || captures.length === 0) return none;
  const capture = captures[0] as Record<string, unknown>;
  return { id: str(capture.id), amount: readAmount(capture.amount) };
}

export function createPayPalOrdersClient(opts: { env?: Env; http?: PayPalHttp } = {}): PayPalOrdersClient {
  const call = createPayPalRequest(opts);

  function fail(what: string, status: number, json: Record<string, unknown>): Error {
    const message = typeof json.message === "string" ? json.message : "no message";
    const name = typeof json.name === "string" ? json.name : String(status);
    return new Error(`PayPal ${what} failed: ${name} — ${message}`);
  }

  return {
    async createOrder(input) {
      const body = {
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: input.customId,
            description: input.description,
            amount: jobPostingAmount(),
          },
        ],
        // The current Orders API takes the buyer-facing settings here.
        payment_source: {
          paypal: {
            experience_context: {
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      };
      const { ok, status, json } = await call("/v2/checkout/orders", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!ok || typeof json.id !== "string") throw fail("create order", status, json);
      return {
        id: json.id,
        status: typeof json.status === "string" ? json.status : "CREATED",
        // The new experience_context flow answers with `payer-action`; the
        // classic one with `approve`. Either is where the buyer goes next.
        approveUrl: linkHref(json.links, "payer-action") ?? linkHref(json.links, "approve"),
      };
    },

    async captureOrder(orderId) {
      const { ok, status, json } = await call(
        `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        { method: "POST", body: "{}" },
      );
      // 422 ORDER_ALREADY_CAPTURED is the webhook having got there first —
      // the state the caller wanted. Read the order back for the capture id.
      if (!ok && status === 422 && json.name === "UNPROCESSABLE_ENTITY") {
        const details = Array.isArray(json.details) ? (json.details as Record<string, unknown>[]) : [];
        if (details.some((d) => d.issue === "ORDER_ALREADY_CAPTURED")) {
          const read = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
          const capture = firstCapture(read.json);
          return {
            id: orderId,
            status: typeof read.json.status === "string" ? read.json.status : "COMPLETED",
            captureId: capture.id,
            amount: capture.amount,
          };
        }
      }
      if (!ok || typeof json.id !== "string") throw fail("capture order", status, json);
      const capture = firstCapture(json);
      return {
        id: json.id,
        status: typeof json.status === "string" ? json.status : "UNKNOWN",
        captureId: capture.id,
        amount: capture.amount,
      };
    },
  };
}

/** Null rather than a throw: the posting page has a "not configured" path. */
export function getPayPalOrdersClient(env: Env = process.env): PayPalOrdersClient | null {
  return billingConfigured(env) ? createPayPalOrdersClient({ env }) : null;
}

export const JOB_RETURN_PATH = "/post-a-job/return";
export const JOB_CANCELLED_PATH = "/post-a-job/cancelled";

/** The two URLs PayPal sends the buyer back to. */
export function jobOrderUrls(): { returnUrl: string; cancelUrl: string } {
  return { returnUrl: siteUrl(JOB_RETURN_PATH), cancelUrl: siteUrl(JOB_CANCELLED_PATH) };
}

/* ----------------------------------------------------------------- webhook */

export const PAYMENT_CAPTURE_COMPLETED = "PAYMENT.CAPTURE.COMPLETED";

export interface CaptureEvent {
  readonly captureId: string;
  readonly orderId: string | null;
  readonly customId: string | null;
  readonly amount: CaptureAmount | null;
}

/**
 * The capture's identifiers. The order id sits under
 * `supplementary_data.related_ids.order_id`; `custom_id` is our own row id
 * carried through from the purchase unit. Either finds the job.
 */
export function captureFromEvent(event: PayPalEvent): CaptureEvent | null {
  if (event.type !== PAYMENT_CAPTURE_COMPLETED) return null;
  const captureId = str(event.resource.id);
  if (captureId === null) return null;
  if (str(event.resource.status) !== "COMPLETED") return null;
  const supplementary = event.resource.supplementary_data;
  const related =
    typeof supplementary === "object" && supplementary !== null
      ? (supplementary as Record<string, unknown>).related_ids
      : null;
  const orderId =
    typeof related === "object" && related !== null
      ? str((related as Record<string, unknown>).order_id)
      : null;
  return { captureId, orderId, customId: str(event.resource.custom_id), amount: readAmount(event.resource.amount) };
}

export type CaptureOutcome = MarkPaidResult["outcome"] | "not-a-capture" | "wrong-amount";

/**
 * Settles a job from its capture event. Runs inside the webhook's transaction,
 * after the signature check and the `processed_events` insert, with the
 * billing system viewer. A capture that names no job we hold — another
 * product on the same PayPal account — is reported, not thrown.
 */
export async function applyCaptureEvent(
  tx: TestDb,
  viewer: Viewer,
  event: PayPalEvent,
): Promise<{ outcome: CaptureOutcome; jobId?: string }> {
  const capture = captureFromEvent(event);
  if (capture === null) return { outcome: "not-a-capture" };

  let orderId = capture.orderId;
  if (orderId === null && capture.customId !== null) {
    orderId = await providerOrderIdForJob(tx, viewer, capture.customId);
  }
  if (orderId === null) return { outcome: "unknown-order" };

  // The amount FIRST, before the row is touched. A capture for any other
  // amount or currency is written down and refused, whichever road found
  // the order — and the custom_id road is exactly the one a stranger's
  // order could take.
  if (!amountMatches(capture.amount)) {
    await recordJobPaymentMismatch(tx, viewer, {
      jobId: capture.customId,
      providerOrderId: orderId,
      eventId: event.id,
      captureId: capture.captureId,
      reason: "wrong-amount",
      amount: capture.amount,
    });
    return { outcome: "wrong-amount" };
  }

  return markJobPaid(tx, viewer, {
    providerOrderId: orderId,
    captureId: capture.captureId,
    eventId: event.id,
    // Both ids present: they must agree. custom_id alone was resolved above.
    expectedJobId: capture.orderId !== null ? capture.customId : null,
  });
}

/* ------------------------------------------------------------- return page */

export type SettleOutcome =
  | { outcome: "not-configured" }
  | { outcome: "unknown-order" }
  | { outcome: "paid"; jobId: string }
  | { outcome: "already-paid"; jobId: string }
  /** PayPal did not complete the capture. Nothing granted; the webhook may still. */
  | { outcome: "not-completed"; jobId: string; status: string };

/**
 * The return page's half: capture the approved order and write it down. The
 * PayPal round trip happens inside the caller's transaction so a capture that
 * completed and a row that says so commit together.
 */
export async function settleJobOrder(
  tx: TestDb,
  input: { client: PayPalOrdersClient | null; viewer: Viewer; orderId: string },
): Promise<SettleOutcome> {
  if (input.client === null) return { outcome: "not-configured" };

  const job = await jobForOrder(tx, input.viewer, input.orderId);
  if (job === null) return { outcome: "unknown-order" };
  if (job.paymentStatus !== "pending") return { outcome: "already-paid", jobId: job.id };

  let captured: CapturedOrder;
  try {
    captured = await input.client.captureOrder(input.orderId);
  } catch (e) {
    // PayPal unreachable or the order not yet approved. Grant nothing; the
    // webhook finishes it if the money did move.
    console.error("[jobs] capture failed:", e instanceof Error ? e.message : String(e));
    return { outcome: "not-completed", jobId: job.id, status: "UNAVAILABLE" };
  }
  if (captured.status !== "COMPLETED") {
    return { outcome: "not-completed", jobId: job.id, status: captured.status };
  }
  if (!amountMatches(captured.amount)) {
    // Money moved for the wrong amount. Nothing granted; on the record for a refund.
    await recordJobPaymentMismatch(tx, input.viewer, {
      jobId: job.id,
      providerOrderId: input.orderId,
      eventId: null,
      captureId: captured.captureId,
      reason: "wrong-amount",
      amount: captured.amount,
    });
    return { outcome: "not-completed", jobId: job.id, status: "AMOUNT_MISMATCH" };
  }

  const marked = await markJobPaid(tx, input.viewer, {
    providerOrderId: input.orderId,
    captureId: captured.captureId,
    eventId: null,
  });
  switch (marked.outcome) {
    case "unknown-order":
      return { outcome: "unknown-order" };
    case "not-pending":
    case "job-mismatch":
      return { outcome: "not-completed", jobId: marked.jobId, status: marked.outcome.toUpperCase() };
    default:
      return marked;
  }
}
