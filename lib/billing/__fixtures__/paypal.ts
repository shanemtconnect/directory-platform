/**
 * Recorded PayPal webhook payloads, trimmed to the fields this codebase reads.
 *
 * Not a test file (vitest only collects `*.test.ts`), and not shipped code
 * either — it exists so the webhook tests run against the shape PayPal really
 * sends rather than one invented to match the parser. No credentials exist in
 * development, so these payloads ARE the integration test.
 */

export const SUB_ID = "I-BW452GLLEP1G";
export const PLAN_ID = "P-5ML4271244454362WXNWU5NQ";

function event(id: string, type: string, resource: Record<string, unknown>) {
  return {
    id,
    event_version: "1.0",
    create_time: "2026-09-12T09:00:00Z",
    resource_type: "subscription",
    event_type: type,
    summary: type,
    resource,
  };
}

export const activated = (over: Record<string, unknown> = {}) =>
  event("WH-ACTIVATED-1", "BILLING.SUBSCRIPTION.ACTIVATED", {
    id: SUB_ID,
    plan_id: PLAN_ID,
    status: "ACTIVE",
    start_time: "2026-09-12T09:00:00Z",
    custom_id: "row-1",
    billing_info: {
      next_billing_time: "2026-10-12T09:00:00Z",
      last_payment: { amount: { currency_code: "GBP", value: "249.00" }, time: "2026-09-12T09:00:00Z" },
    },
    ...over,
  });

export const updated = (over: Record<string, unknown> = {}) =>
  event("WH-UPDATED-1", "BILLING.SUBSCRIPTION.UPDATED", {
    id: SUB_ID,
    plan_id: PLAN_ID,
    status: "ACTIVE",
    billing_info: { next_billing_time: "2027-09-12T09:00:00Z" },
    ...over,
  });

export const cancelled = (over: Record<string, unknown> = {}) =>
  event("WH-CANCELLED-1", "BILLING.SUBSCRIPTION.CANCELLED", {
    id: SUB_ID,
    plan_id: PLAN_ID,
    status: "CANCELLED",
    billing_info: { next_billing_time: "2027-09-12T09:00:00Z" },
    ...over,
  });

export const suspended = (over: Record<string, unknown> = {}) =>
  event("WH-SUSPENDED-1", "BILLING.SUBSCRIPTION.SUSPENDED", {
    id: SUB_ID,
    plan_id: PLAN_ID,
    status: "SUSPENDED",
    ...over,
  });

export const expired = (over: Record<string, unknown> = {}) =>
  event("WH-EXPIRED-1", "BILLING.SUBSCRIPTION.EXPIRED", {
    id: SUB_ID,
    plan_id: PLAN_ID,
    status: "EXPIRED",
    ...over,
  });

export const paymentFailed = (over: Record<string, unknown> = {}) =>
  event("WH-FAILED-1", "BILLING.SUBSCRIPTION.PAYMENT.FAILED", {
    id: SUB_ID,
    plan_id: PLAN_ID,
    status: "ACTIVE",
    billing_info: { failed_payments_count: 1, next_billing_time: "2026-10-12T09:00:00Z" },
    ...over,
  });

export const saleCompleted = (over: Record<string, unknown> = {}) => ({
  id: "WH-SALE-1",
  event_version: "1.0",
  create_time: "2027-09-12T09:00:05Z",
  resource_type: "sale",
  event_type: "PAYMENT.SALE.COMPLETED",
  summary: "Payment completed for GBP 249.0",
  resource: {
    id: "5TY05013RG002845M",
    state: "completed",
    amount: { total: "249.00", currency: "GBP" },
    billing_agreement_id: SUB_ID,
    create_time: "2027-09-12T09:00:05Z",
    ...over,
  },
});

export const unknownEvent = () =>
  event("WH-UNKNOWN-1", "CHECKOUT.ORDER.APPROVED", { id: "5O190127TN364715T" });
