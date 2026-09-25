import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { auditLog, creditOrders, jobQueue, jobs, profiles, user } from "@/lib/db/schema";
import { makeScaffold } from "@/test/factories";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { attachJobOrder, createJob } from "@/lib/db/queries/job-board";
import { creditBalance } from "@/lib/db/queries/credits";
import { NOTIFY_CREDIT_TOPUP } from "@/lib/email/notify";
import { BILLING_SYSTEM_VIEWER, processPayPalWebhook } from "./process";
import type { PayPalClient } from "./paypal";
import { parseEvent } from "./webhooks";
import { applyCaptureEvent, amountMatches, creditTopupAmount, type CreateOrderInput, type PayPalOrdersClient } from "./orders";
import { settleTopupOrder, startTopup, topupPackCents } from "./credit-topup";

const ORDER = "8TOPUP0127TN3647";
const CAPTURE = "9CAPT366HH90899";

async function makeAccount(tx: TestDb): Promise<{ viewer: Viewer; profileId: string }> {
  const id = `u_${randomUUID()}`;
  await tx.insert(user).values({ id, name: "Topper", email: `${id}@example.com` });
  const [p] = await tx.insert(profiles).values({ userId: id }).returning({ id: profiles.id });
  return { viewer: { role: "user", userId: id }, profileId: p!.id };
}

function fakeOrders(
  opts: { status?: string; amount?: { value: string; currencyCode: string } | null; approveUrl?: string | null } = {},
): PayPalOrdersClient & { created: CreateOrderInput[]; captured: string[] } {
  const created: CreateOrderInput[] = [];
  const captured: string[] = [];
  return {
    created,
    captured,
    createOrder: async (input) => {
      created.push(input);
      return { id: ORDER, status: "PAYER_ACTION_REQUIRED", approveUrl: opts.approveUrl === undefined ? "https://paypal.test/approve?token=" + ORDER : opts.approveUrl };
    },
    captureOrder: async (id) => {
      captured.push(id);
      return {
        id,
        status: opts.status ?? "COMPLETED",
        captureId: CAPTURE,
        amount: opts.amount === undefined ? { value: "50.00", currencyCode: "GBP" } : opts.amount,
      };
    },
  };
}

/** A started top-up for the smallest pack: returns the account and the credit_orders id. */
async function startedTopup(tx: TestDb) {
  const account = await makeAccount(tx);
  const out = await startTopup(tx, account.viewer, 5000, { client: fakeOrders() });
  if (out.outcome !== "pay") throw new Error("setup");
  return { ...account, creditOrderId: out.creditOrderId };
}

function captureEvent(over: Record<string, unknown> = {}, id = `WH-TOPUP-${randomUUID()}`) {
  return {
    id,
    event_version: "1.0",
    create_time: "2026-09-25T10:00:00Z",
    resource_type: "capture",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    summary: "Payment completed for GBP 50.00",
    resource: {
      id: CAPTURE,
      status: "COMPLETED",
      amount: { currency_code: "GBP", value: "50.00" },
      supplementary_data: { related_ids: { order_id: ORDER } },
      ...over,
    },
  };
}

async function orderStatus(tx: TestDb, id: string): Promise<string | undefined> {
  const [row] = await tx.select({ s: creditOrders.status }).from(creditOrders).where(eq(creditOrders.id, id));
  return row?.s;
}

async function receipts(tx: TestDb, creditOrderId: string): Promise<number> {
  const rows = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_CREDIT_TOPUP));
  return rows.filter((r) => (r.payload as { creditOrderId?: string }).creditOrderId === creditOrderId).length;
}

describe("creditTopupAmount and amountMatches per purpose", () => {
  it("writes a pack as PayPal wants it and matches only that amount in the site currency", () => {
    expect(creditTopupAmount(5000)).toEqual({ value: "50.00", currency_code: "GBP" });
    expect(creditTopupAmount(12345)).toEqual({ value: "123.45", currency_code: "GBP" });
    expect(amountMatches({ value: "50.00", currencyCode: "GBP" }, creditTopupAmount(5000))).toBe(true);
    expect(amountMatches({ value: "50.00", currencyCode: "USD" }, creditTopupAmount(5000))).toBe(false);
    expect(amountMatches({ value: "29.00", currencyCode: "GBP" }, creditTopupAmount(5000))).toBe(false);
    // The job default is untouched.
    expect(amountMatches({ value: "29.00", currencyCode: "GBP" })).toBe(true);
  });

  it("offers exactly the configured packs, in minor units", () => {
    expect(topupPackCents()).toEqual([5000, 10000, 30000]);
  });
});

describe("startTopup", () => {
  it("refuses a pack that is not in config, and writes nothing", async () => {
    await withTestDb(async (tx) => {
      const { viewer, profileId } = await makeAccount(tx);
      const client = fakeOrders();
      for (const pack of [0, 4999, 5001, 20000, -5000]) {
        expect(await startTopup(tx, viewer, pack, { client }), String(pack)).toEqual({ outcome: "invalid-pack" });
      }
      expect(client.created).toEqual([]);
      expect(await tx.select().from(creditOrders).where(eq(creditOrders.userId, profileId))).toEqual([]);
    });
  });

  it("says so when PayPal is not configured, and refuses an anonymous viewer", async () => {
    await withTestDb(async (tx) => {
      const { viewer } = await makeAccount(tx);
      expect(await startTopup(tx, viewer, 5000, { client: null })).toEqual({ outcome: "not-configured" });
      await expect(startTopup(tx, PUBLIC_VIEWER, 5000, { client: fakeOrders() })).rejects.toThrow(/FORBIDDEN/);
    });
  });

  it("creates the order row and a PayPal order for exactly the pack, tagged credit:<row id>", async () => {
    await withTestDb(async (tx) => {
      const { viewer, profileId } = await makeAccount(tx);
      const client = fakeOrders();
      const out = await startTopup(tx, viewer, 5000, { client });
      expect(out).toMatchObject({ outcome: "pay", approveUrl: `https://paypal.test/approve?token=${ORDER}`, orderId: ORDER });
      if (out.outcome !== "pay") throw new Error("unreachable");

      expect(client.created).toHaveLength(1);
      const input = client.created[0]!;
      expect(input.customId).toBe(`credit:${out.creditOrderId}`);
      expect(input.purpose).toBe("credit_topup");
      expect(input.amount).toEqual({ value: "50.00", currency: "GBP" });
      expect(input.returnUrl).toMatch(/\/account\/credit\/return$/);
      expect(input.cancelUrl).toMatch(/\/account\/credit\/cancelled$/);

      const [row] = await tx.select().from(creditOrders).where(eq(creditOrders.id, out.creditOrderId));
      expect(row).toMatchObject({ userId: profileId, packCents: 5000, providerOrderId: ORDER, status: "created" });
      expect(await creditBalance(tx, profileId)).toBe(0);
    });
  });
});

describe("applyCaptureEvent dispatch", () => {
  it("a credit: custom_id credits the account once and queues one receipt", async () => {
    await withTestDb(async (tx) => {
      const { profileId, creditOrderId } = await startedTopup(tx);
      const event = parseEvent(captureEvent({ custom_id: `credit:${creditOrderId}` }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, event)).toEqual({ outcome: "credited", creditOrderId });
      expect(await creditBalance(tx, profileId)).toBe(5000);
      expect(await orderStatus(tx, creditOrderId)).toBe("captured");

      // A second delivery (a different event for the same capture) changes nothing.
      const again = parseEvent(captureEvent({ custom_id: `credit:${creditOrderId}` }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, again)).toEqual({ outcome: "already-credited", creditOrderId });
      expect(await creditBalance(tx, profileId)).toBe(5000);
      expect(await receipts(tx, creditOrderId)).toBe(1);
    });
  });

  it("credits by custom_id alone when the event carries no order id", async () => {
    await withTestDb(async (tx) => {
      const { profileId, creditOrderId } = await startedTopup(tx);
      const event = parseEvent(captureEvent({ custom_id: `credit:${creditOrderId}`, supplementary_data: undefined }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, event)).toEqual({ outcome: "credited", creditOrderId });
      expect(await creditBalance(tx, profileId)).toBe(5000);
    });
  });

  it("refuses the wrong amount or currency: nothing credited, the order failed, an audit row written", async () => {
    for (const amount of [{ currency_code: "GBP", value: "0.01" }, { currency_code: "USD", value: "50.00" }, undefined]) {
      await withTestDb(async (tx) => {
        const { profileId, creditOrderId } = await startedTopup(tx);
        const event = parseEvent(captureEvent({ custom_id: `credit:${creditOrderId}`, amount }))!;
        expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, event)).toEqual({ outcome: "wrong-amount", creditOrderId });
        expect(await creditBalance(tx, profileId)).toBe(0);
        expect(await orderStatus(tx, creditOrderId)).toBe("failed");
        const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, creditOrderId));
        expect(audits.map((a) => a.action)).toEqual(["credit.payment.mismatch"]);
      });
    }
  });

  it("ignores a credit capture for an unknown order or one whose order id disagrees", async () => {
    await withTestDb(async (tx) => {
      const unknown = parseEvent(captureEvent({ custom_id: `credit:${randomUUID()}` }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, unknown)).toEqual({ outcome: "unknown-order" });
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, parseEvent(captureEvent({ custom_id: "credit:not-a-uuid" }))!))
        .toEqual({ outcome: "unknown-order" });

      const { profileId, creditOrderId } = await startedTopup(tx);
      const other = parseEvent(captureEvent({ custom_id: `credit:${creditOrderId}`, supplementary_data: { related_ids: { order_id: "SOMEONE-ELSE" } } }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, other)).toEqual({ outcome: "order-mismatch", creditOrderId });
      expect(await creditBalance(tx, profileId)).toBe(0);
      expect(await orderStatus(tx, creditOrderId)).toBe("created");
    });
  });

  it("a job: custom_id still settles the job", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const created = await createJob(tx, PUBLIC_VIEWER, {
        title: "Coordinator", description: "Run the diary.", companyName: "Acme", posterName: "Pat",
        posterEmail: "pat@example.co.uk", cityId: ctx.cityId, categoryId: ctx.primaryCategoryId,
        budgetMin: null, budgetMax: null, applyMethod: "email", applyEmail: "pat@example.co.uk",
        applyUrl: null, listingId: null, posterProfileId: null, ip: null,
      });
      if (created.outcome !== "created") throw new Error("setup");
      const jobOrder = "JOBORDER12345";
      await attachJobOrder(tx, PUBLIC_VIEWER, { jobId: created.jobId, providerOrderId: jobOrder });
      const event = parseEvent(captureEvent({
        custom_id: `job:${created.jobId}`,
        amount: { currency_code: "GBP", value: "29.00" },
        supplementary_data: { related_ids: { order_id: jobOrder } },
      }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, event)).toEqual({ outcome: "paid", jobId: created.jobId });
      const [job] = await tx.select({ s: jobs.paymentStatus }).from(jobs).where(eq(jobs.id, created.jobId));
      expect(job?.s).toBe("paid");
    });
  });
});

describe("settleTopupOrder", () => {
  it("captures on the return page and credits once; a refresh captures nothing more", async () => {
    await withTestDb(async (tx) => {
      const { profileId, creditOrderId } = await startedTopup(tx);
      const client = fakeOrders();
      expect(await settleTopupOrder(tx, { client, viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER }))
        .toEqual({ outcome: "credited", creditOrderId, userId: profileId, cents: 5000 });
      expect(await settleTopupOrder(tx, { client, viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER }))
        .toEqual({ outcome: "already-credited", creditOrderId, userId: profileId, cents: 5000 });
      expect(client.captured).toEqual([ORDER]);
      expect(await creditBalance(tx, profileId)).toBe(5000);
      expect(await receipts(tx, creditOrderId)).toBe(1);
    });
  });

  it("webhook first, then the return page: exactly one credit", async () => {
    await withTestDb(async (tx) => {
      const { profileId, creditOrderId } = await startedTopup(tx);
      await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, parseEvent(captureEvent({ custom_id: `credit:${creditOrderId}` }))!);
      const client = fakeOrders();
      expect(await settleTopupOrder(tx, { client, viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER }))
        .toMatchObject({ outcome: "already-credited", creditOrderId });
      expect(client.captured).toEqual([]);
      expect(await creditBalance(tx, profileId)).toBe(5000);
    });
  });

  it("return page first, then the webhook: exactly one credit", async () => {
    await withTestDb(async (tx) => {
      const { profileId, creditOrderId } = await startedTopup(tx);
      await settleTopupOrder(tx, { client: fakeOrders(), viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER });
      const event = parseEvent(captureEvent({ custom_id: `credit:${creditOrderId}` }))!;
      expect(await applyCaptureEvent(tx, BILLING_SYSTEM_VIEWER, event)).toEqual({ outcome: "already-credited", creditOrderId });
      expect(await creditBalance(tx, profileId)).toBe(5000);
      expect(await receipts(tx, creditOrderId)).toBe(1);
    });
  });

  it("grants nothing for the wrong amount, an incomplete capture, no PayPal, or an unknown order", async () => {
    await withTestDb(async (tx) => {
      const { profileId, creditOrderId } = await startedTopup(tx);
      expect(await settleTopupOrder(tx, { client: null, viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER })).toEqual({ outcome: "not-configured" });
      expect(await settleTopupOrder(tx, { client: fakeOrders(), viewer: BILLING_SYSTEM_VIEWER, orderId: "NOPE" })).toEqual({ outcome: "unknown-order" });
      expect(await settleTopupOrder(tx, { client: fakeOrders({ status: "PENDING" }), viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER }))
        .toEqual({ outcome: "not-completed", creditOrderId, userId: profileId, status: "PENDING" });
      expect(await settleTopupOrder(tx, { client: fakeOrders({ amount: { value: "1.00", currencyCode: "GBP" } }), viewer: BILLING_SYSTEM_VIEWER, orderId: ORDER }))
        .toEqual({ outcome: "not-completed", creditOrderId, userId: profileId, status: "AMOUNT_MISMATCH" });
      expect(await creditBalance(tx, profileId)).toBe(0);
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, creditOrderId), eq(auditLog.action, "credit.payment.mismatch")));
      expect(audits).toHaveLength(1);
    });
  });
});

describe("the webhook endpoint with a credit capture", () => {
  const HEADERS = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/c.pem",
    "paypal-transmission-id": "t",
    "paypal-transmission-sig": "s",
    "paypal-transmission-time": "2026-09-25T10:00:00Z",
  };
  const client: PayPalClient = {
    createSubscription: async () => ({ id: "I", status: "APPROVAL_PENDING", approveUrl: null }),
    getSubscription: async () => null,
    cancelSubscription: async () => {},
    manageUrl: async () => null,
    verifyWebhookSignature: async () => true,
  };

  it("applies it once and reports the credit", async () => {
    await withTestDb(async (tx) => {
      const { profileId, creditOrderId } = await startedTopup(tx);
      const req = { raw: JSON.stringify(captureEvent({ custom_id: `credit:${creditOrderId}` }, "WH-TOPUP-FIXED")), headers: HEADERS, client, env: {} };
      expect(await processPayPalWebhook(tx, req)).toMatchObject({ status: 200, outcome: "applied", detail: "capture:credited" });
      expect(await processPayPalWebhook(tx, req)).toMatchObject({ status: 200, outcome: "duplicate" });
      expect(await creditBalance(tx, profileId)).toBe(5000);
    });
  });
});
