import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { auditLog, jobs, processedEvents } from "@/lib/db/schema";
import { makeScaffold } from "@/test/factories";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { attachJobOrder, createJob } from "@/lib/db/queries/job-board";
import { BILLING_SYSTEM_VIEWER, processPayPalWebhook } from "./process";
import type { PayPalClient, PayPalHttp } from "./paypal";
import { parseEvent } from "./webhooks";
import {
  applyCaptureEvent,
  captureFromEvent,
  createPayPalOrdersClient,
  getPayPalOrdersClient,
  jobPostingAmount,
  settleJobOrder,
  type PayPalOrdersClient,
} from "./orders";

const ENV = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_WEBHOOK_ID: "WH" };
const ORDER = "5O190127TN364715T";
const CAPTURE = "3C679366HH908993F";

interface Call { url: string; init: RequestInit }

function stub(responses: Record<string, { status?: number; body: unknown }>): { http: PayPalHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: PayPalHttp = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.endsWith(k) || url.includes(k));
    const hit = key === undefined ? undefined : responses[key];
    return new Response(JSON.stringify(hit?.body ?? {}), {
      status: hit === undefined ? 404 : (hit.status ?? 200),
      headers: { "content-type": "application/json" },
    });
  };
  return { http, calls };
}

const TOKEN = { "/v1/oauth2/token": { body: { access_token: "tok", expires_in: 32400 } } };

/** A recorded PAYMENT.CAPTURE.COMPLETED, trimmed to what is read. */
function captureEvent(over: Record<string, unknown> = {}, id = "WH-CAPTURE-1") {
  return {
    id,
    event_version: "1.0",
    create_time: "2026-09-22T10:00:00Z",
    resource_type: "capture",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    summary: "Payment completed for GBP 29.00",
    resource: {
      id: CAPTURE,
      status: "COMPLETED",
      amount: { currency_code: "GBP", value: "29.00" },
      custom_id: "row-1",
      supplementary_data: { related_ids: { order_id: ORDER } },
      ...over,
    },
  };
}

function fakeSubscriptionClient(verify = true): PayPalClient {
  return {
    createSubscription: async () => ({ id: "I", status: "APPROVAL_PENDING", approveUrl: null }),
    getSubscription: async () => null,
    cancelSubscription: async () => {},
    manageUrl: async () => null,
    verifyWebhookSignature: async () => verify,
  };
}

const HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/c.pem",
  "paypal-transmission-id": "t",
  "paypal-transmission-sig": "s",
  "paypal-transmission-time": "2026-09-22T10:00:00Z",
};

async function pendingJob(tx: TestDb): Promise<string> {
  const ctx = await makeScaffold(tx);
  const created = await createJob(tx, PUBLIC_VIEWER, {
    title: "Coordinator",
    description: "Run the diary.",
    companyName: "Acme",
    posterName: "Pat",
    posterEmail: "pat@example.co.uk",
    cityId: ctx.cityId,
    categoryId: ctx.primaryCategoryId,
    budgetMin: null,
    budgetMax: null,
    applyMethod: "email",
    applyEmail: "pat@example.co.uk",
    applyUrl: null,
    listingId: null,
    posterProfileId: null,
    ip: null,
  });
  if (created.outcome !== "created") throw new Error("setup");
  await attachJobOrder(tx, PUBLIC_VIEWER, { jobId: created.jobId, providerOrderId: ORDER });
  return created.jobId;
}

async function paymentStatus(tx: TestDb, id: string): Promise<string | undefined> {
  const [row] = await tx.select({ s: jobs.paymentStatus }).from(jobs).where(eq(jobs.id, id)).limit(1);
  return row?.s;
}

describe("jobPostingAmount", () => {
  it("is the configured price in the site currency, to the penny", () => {
    const amount = jobPostingAmount();
    expect(amount.value).toMatch(/^\d+\.\d{2}$/);
    expect(amount.currency_code).toBe("GBP");
  });
});

describe("createPayPalOrdersClient", () => {
  it("creates a CAPTURE order carrying our row id and returns where the buyer goes", async () => {
    const { http, calls } = stub({
      ...TOKEN,
      "/v2/checkout/orders": {
        body: { id: ORDER, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=X" }] },
      },
    });
    const client = createPayPalOrdersClient({ env: ENV, http });
    const order = await client.createOrder({
      customId: "job-1",
      description: "A job post",
      returnUrl: "https://example.test/post-a-job/return",
      cancelUrl: "https://example.test/post-a-job/cancelled",
    });
    expect(order).toEqual({ id: ORDER, status: "PAYER_ACTION_REQUIRED", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=X" });

    const create = calls.find((c) => c.url.endsWith("/v2/checkout/orders"));
    const body = JSON.parse(String(create?.init.body)) as Record<string, unknown>;
    expect(body.intent).toBe("CAPTURE");
    const unit = (body.purchase_units as Record<string, unknown>[])[0]!;
    expect(unit.custom_id).toBe("job-1");
    expect(unit.amount).toEqual(jobPostingAmount());
    expect(JSON.stringify(body)).toContain("/post-a-job/return");
  });

  it("captures and reads the capture id out of the purchase unit", async () => {
    const { http } = stub({
      ...TOKEN,
      [`/v2/checkout/orders/${ORDER}/capture`]: {
        body: { id: ORDER, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: CAPTURE, status: "COMPLETED", amount: { currency_code: "GBP", value: "29.00" } }] } }] },
      },
    });
    const client = createPayPalOrdersClient({ env: ENV, http });
    expect(await client.captureOrder(ORDER)).toEqual({ id: ORDER, status: "COMPLETED", captureId: CAPTURE, amount: { value: "29.00", currencyCode: "GBP" } });
  });

  it("treats ORDER_ALREADY_CAPTURED as done and reads the order back", async () => {
    const { http } = stub({
      ...TOKEN,
      [`/v2/checkout/orders/${ORDER}/capture`]: {
        status: 422,
        body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
      },
      [`/v2/checkout/orders/${ORDER}`]: {
        body: { id: ORDER, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: CAPTURE, amount: { currency_code: "GBP", value: "29.00" } }] } }] },
      },
    });
    const client = createPayPalOrdersClient({ env: ENV, http });
    expect(await client.captureOrder(ORDER)).toEqual({ id: ORDER, status: "COMPLETED", captureId: CAPTURE, amount: { value: "29.00", currencyCode: "GBP" } });
  });

  it("throws PayPal's own message on any other failure", async () => {
    const { http } = stub({
      ...TOKEN,
      [`/v2/checkout/orders/${ORDER}/capture`]: { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "Order not approved", details: [{ issue: "ORDER_NOT_APPROVED" }] } },
    });
    const client = createPayPalOrdersClient({ env: ENV, http });
    await expect(client.captureOrder(ORDER)).rejects.toThrow(/Order not approved/);
  });

  it("is null without credentials", () => {
    expect(getPayPalOrdersClient({})).toBeNull();
    expect(getPayPalOrdersClient(ENV)).not.toBeNull();
  });
});

describe("captureFromEvent", () => {
  it("reads the capture, order and custom ids off a completed capture only", () => {
    const event = parseEvent(captureEvent())!;
    expect(captureFromEvent(event)).toEqual({ captureId: CAPTURE, orderId: ORDER, customId: "row-1", amount: { value: "29.00", currencyCode: "GBP" } });
    expect(captureFromEvent(parseEvent(captureEvent({ status: "PENDING" }))!)).toBeNull();
    expect(captureFromEvent(parseEvent({ ...captureEvent(), event_type: "PAYMENT.CAPTURE.DENIED" })!)).toBeNull();
    expect(captureFromEvent(parseEvent(captureEvent({ supplementary_data: undefined }))!))
      .toEqual({ captureId: CAPTURE, orderId: null, customId: "row-1", amount: { value: "29.00", currencyCode: "GBP" } });
  });
});

describe("applyCaptureEvent", () => {
  it("settles the job by order id, and by custom_id when the order id is missing", async () => {
    await withTestDb(async (tx) => {
      const jobId = await pendingJob(tx);
      const byOrder = await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, parseEvent(captureEvent({ custom_id: jobId }))!);
      expect(byOrder).toEqual({ outcome: "paid", jobId });
      expect(await paymentStatus(tx, jobId)).toBe("paid");
    });
    await withTestDb(async (tx) => {
      const jobId = await pendingJob(tx);
      const event = parseEvent(captureEvent({ custom_id: jobId, supplementary_data: undefined }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, event)).toEqual({ outcome: "paid", jobId });
    });
  });

  it("refuses the wrong amount, the wrong currency, and a custom_id that is not the order's job — writing nothing but an audit row", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["wrong amount", { amount: { currency_code: "GBP", value: "0.01" } }],
      ["wrong currency", { amount: { currency_code: "USD", value: "29.00" } }],
      ["no amount at all", { amount: undefined }],
    ];
    for (const [label, over] of cases) {
      await withTestDb(async (tx) => {
        const jobId = await pendingJob(tx);
        const event = parseEvent(captureEvent({ custom_id: jobId, ...over }))!;
        expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, event), label).toEqual({ outcome: "wrong-amount" });
        expect(await paymentStatus(tx, jobId), label).toBe("pending");
        const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, jobId));
        expect(audits.map((a) => a.action), label).toEqual(["job.payment.mismatch"]);
      });
    }
    // The custom_id road alone, for the wrong amount: the stranger's-order shape.
    await withTestDb(async (tx) => {
      const jobId = await pendingJob(tx);
      const event = parseEvent(captureEvent({ custom_id: jobId, supplementary_data: undefined, amount: { currency_code: "GBP", value: "0.01" } }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, event)).toEqual({ outcome: "wrong-amount" });
      expect(await paymentStatus(tx, jobId)).toBe("pending");
    });
    // Both ids present and disagreeing.
    await withTestDb(async (tx) => {
      const jobId = await pendingJob(tx);
      const event = parseEvent(captureEvent({ custom_id: randomUUID() }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, event)).toEqual({ outcome: "job-mismatch", jobId });
      expect(await paymentStatus(tx, jobId)).toBe("pending");
      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, jobId));
      expect(audits.map((a) => a.action)).toEqual(["job.payment.mismatch"]);
    });
  });

  it("reports a capture for an order this site does not hold", async () => {
    await withTestDb(async (tx) => {
      const event = parseEvent(captureEvent({ custom_id: randomUUID(), supplementary_data: { related_ids: { order_id: "OTHER" } } }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, event)).toEqual({ outcome: "unknown-order" });
    });
  });
});

describe("the webhook endpoint with a capture", () => {
  it("marks the job paid once, records the event, and shrugs at the redelivery", async () => {
    await withTestDb(async (tx) => {
      const jobId = await pendingJob(tx);
      const req = { raw: JSON.stringify(captureEvent({ custom_id: jobId })), headers: HEADERS, client: fakeSubscriptionClient(), env: ENV };

      const first = await processPayPalWebhook(tx, req);
      expect(first).toMatchObject({ status: 200, outcome: "applied", detail: "capture:paid" });
      expect(await paymentStatus(tx, jobId)).toBe("paid");

      const again = await processPayPalWebhook(tx, req);
      expect(again).toMatchObject({ status: 200, outcome: "duplicate" });

      const recorded = await tx.select().from(processedEvents).where(eq(processedEvents.eventId, "WH-CAPTURE-1"));
      expect(recorded).toHaveLength(1);
    });
  });

  it("200s a capture for the wrong amount as ignored, so PayPal does not retry, and marks nothing paid", async () => {
    await withTestDb(async (tx) => {
      const jobId = await pendingJob(tx);
      const event = captureEvent({ custom_id: jobId, amount: { currency_code: "GBP", value: "1.00" } }, "WH-CAPTURE-3");
      const req = { raw: JSON.stringify(event), headers: HEADERS, client: fakeSubscriptionClient(), env: ENV };
      expect(await processPayPalWebhook(tx, req)).toMatchObject({ status: 200, outcome: "ignored", detail: "capture:wrong-amount" });
      expect(await paymentStatus(tx, jobId)).toBe("pending");
    });
  });

  it("writes nothing for an unverified capture", async () => {
    await withTestDb(async (tx) => {
      const jobId = await pendingJob(tx);
      const req = { raw: JSON.stringify(captureEvent()), headers: HEADERS, client: fakeSubscriptionClient(false), env: ENV };
      expect((await processPayPalWebhook(tx, req)).status).toBe(401);
      expect(await paymentStatus(tx, jobId)).toBe("pending");
    });
  });

  it("200s a capture that is not ours without touching a row", async () => {
    await withTestDb(async (tx) => {
      const event = captureEvent({ custom_id: "not-ours", supplementary_data: { related_ids: { order_id: "OTHER" } } }, "WH-CAPTURE-2");
      const req = { raw: JSON.stringify(event), headers: HEADERS, client: fakeSubscriptionClient(), env: ENV };
      expect(await processPayPalWebhook(tx, req)).toMatchObject({ status: 200, outcome: "ignored", detail: "capture:unknown-order" });
    });
  });
});

describe("settleJobOrder", () => {
  function fakeOrders(
    status = "COMPLETED",
    amount: { value: string; currencyCode: string } | null = { value: "29.00", currencyCode: "GBP" },
  ): PayPalOrdersClient & { captured: string[] } {
    const captured: string[] = [];
    return {
      captured,
      createOrder: async () => ({ id: ORDER, status: "CREATED", approveUrl: null }),
      captureOrder: async (id) => {
        captured.push(id);
        return { id, status, captureId: CAPTURE, amount };
      },
    };
  }

  it("refuses a completed capture for the wrong amount or currency, on the record", async () => {
    for (const amount of [{ value: "0.01", currencyCode: "GBP" }, { value: "29.00", currencyCode: "USD" }, null]) {
      await withTestDb(async (tx) => {
        const jobId = await pendingJob(tx);
        const out = await settleJobOrder(tx, { client: fakeOrders("COMPLETED", amount), viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER });
        expect(out).toEqual({ outcome: "not-completed", jobId, status: "AMOUNT_MISMATCH" });
        expect(await paymentStatus(tx, jobId)).toBe("pending");
        const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, jobId));
        expect(audits.map((a) => a.action)).toEqual(["job.payment.mismatch"]);
      });
    }
  });

  it("captures inside the transaction and marks the job paid", async () => {
    await withTestDb(async (tx) => {
      const jobId = await pendingJob(tx);
      const client = fakeOrders();
      const out = await settleJobOrder(tx, { client, viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER });
      expect(out).toEqual({ outcome: "paid", jobId });
      expect(client.captured).toEqual([ORDER]);
      expect(await paymentStatus(tx, jobId)).toBe("paid");
      // The second visit — a refresh — captures nothing and grants nothing new.
      expect(await settleJobOrder(tx, { client, viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER }))
        .toEqual({ outcome: "already-paid", jobId });
      expect(client.captured).toEqual([ORDER]);
    });
  });

  it("grants nothing when PayPal does not complete the capture, or is not configured, or the order is unknown", async () => {
    await withTestDb(async (tx) => {
      const jobId = await pendingJob(tx);
      expect(await settleJobOrder(tx, { client: fakeOrders("PENDING"), viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER }))
        .toEqual({ outcome: "not-completed", jobId, status: "PENDING" });
      expect(await paymentStatus(tx, jobId)).toBe("pending");
      expect(await settleJobOrder(tx, { client: null, viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER })).toEqual({ outcome: "not-configured" });
      expect(await settleJobOrder(tx, { client: fakeOrders(), viewer: BILLING_SYSTEM_VIEWER, orderId: "nope" })).toEqual({ outcome: "unknown-order" });
    });
  });
});
