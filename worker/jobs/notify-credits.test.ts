import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb, type TestDb } from "@/test/db";
import { profiles, user } from "@/lib/db/schema";
import type { SendResult } from "@/lib/email/sender";
import type { PayPalOrdersClient } from "@/lib/billing/orders";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();
vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { startTopup, settleTopupOrder } = await import("@/lib/billing/credit-topup");
const { BILLING_SYSTEM_VIEWER } = await import("@/lib/billing/process");
const { postLedger } = await import("@/lib/db/queries/credits");
const { notifyCreditTopup } = await import("@/lib/email/notify");
const { processNotifications } = await import("./notify");

const ENV = { ...process.env };
beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ sent: true, id: "eml_1" });
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";
});
afterEach(() => {
  process.env = { ...ENV };
});

const orders: PayPalOrdersClient = {
  createOrder: async () => ({ id: "RECEIPT-ORDER-1", status: "CREATED", approveUrl: "https://paypal.test/a" }),
  captureOrder: async (id) => ({ id, status: "COMPLETED", captureId: "C1", amount: { value: "50.00", currencyCode: "GBP" } }),
};

async function account(tx: TestDb) {
  const id = `u_${randomUUID()}`;
  const email = `${id}@example.test`;
  await tx.insert(user).values({ id, name: "Pat Buyer", email });
  const [p] = await tx.insert(profiles).values({ userId: id }).returning({ id: profiles.id });
  return { viewer: { role: "user" as const, userId: id }, profileId: p!.id, email };
}

describe("notify.credit.topup", () => {
  it("sends the buyer a receipt with the amount and the balance as it stands", async () => {
    await withTestDb(async (tx) => {
      const a = await account(tx);
      await postLedger(tx, BILLING_SYSTEM_VIEWER, { userId: a.profileId, deltaCents: 2500, kind: "adjust", note: "earlier" });
      await startTopup(tx, a.viewer, 5000, { client: orders });
      const settled = await settleTopupOrder(tx, { client: orders, viewer: BILLING_SYSTEM_VIEWER, orderId: "RECEIPT-ORDER-1" });
      expect(settled.outcome).toBe("credited");

      await processNotifications(tx);
      const mine = sendEmail.mock.calls.map((c) => c[0]!).filter((m) => m.to === a.email);
      expect(mine).toHaveLength(1);
      expect(String(mine[0]!.text)).toContain("£50");
      expect(String(mine[0]!.text)).toContain("£75");
      expect(String(mine[0]!.text)).toContain("https://example.co.uk/account/credit");
    });
  });

  it("sends nothing for an order that was never captured", async () => {
    await withTestDb(async (tx) => {
      const a = await account(tx);
      const started = await startTopup(tx, a.viewer, 5000, { client: orders });
      if (started.outcome !== "pay") throw new Error("setup");
      await notifyCreditTopup(tx, BILLING_SYSTEM_VIEWER, started.creditOrderId);
      await processNotifications(tx);
      expect(sendEmail.mock.calls.filter((c) => c[0]!.to === a.email)).toHaveLength(0);
    });
  });
});
