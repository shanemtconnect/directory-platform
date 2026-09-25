import { eq } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import { now } from "@/lib/clock";
import { siteUrl } from "@/lib/schema/builders";
import { ensureProfile } from "@/lib/auth/profile";
import { creditOrders } from "@/lib/db/schema";
import { writeAuditAs } from "@/lib/db/queries/audit";
import { postLedger } from "@/lib/db/queries/credits";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { notifyCreditTopup } from "@/lib/email/notify";
import {
  CREDIT_CUSTOM_ID_PREFIX,
  amountMatches,
  creditTopupAmount,
  getPayPalOrdersClient,
  type CaptureAmount,
  type CaptureEvent,
  type CapturedOrder,
  type PayPalOrdersClient,
} from "./orders";

/**
 * Lead-credit top-ups through PayPal Orders (Task 57, flag `leadMarketplace`).
 *
 * The same one-off Orders pair the jobs board uses (lib/billing/orders.ts):
 * a `credit_orders` row, an order created for exactly one configured pack
 * with `custom_id = credit:<row id>`, and two roads to "paid" — the return
 * page captures while the buyer is standing there, and the
 * `PAYMENT.CAPTURE.COMPLETED` webhook settles the buyer who closed the tab.
 *
 * Exactly once, whichever arrives first: both lock the `credit_orders` row
 * (`FOR UPDATE`), a row already `captured` is reported and left alone, and
 * the ledger's unique `order_id` refuses a second top-up entry for the same
 * PayPal order even if the row lock were somehow bypassed.
 *
 * The amount is checked against the row's `pack_cents` in the site currency
 * before a penny is credited — the same rule as a job.
 */

export const CREDIT_PATH = "/account/credit";
export const CREDIT_RETURN_PATH = "/account/credit/return";
export const CREDIT_CANCELLED_PATH = "/account/credit/cancelled";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The configured packs (`siteConfig.leads.packs`, major units) in minor units. */
export function topupPackCents(): number[] {
  return siteConfig.leads.packs.map((pack) => pack * 100);
}

export type StartTopupResult =
  | { outcome: "pay"; approveUrl: string; orderId: string; creditOrderId: string }
  | { outcome: "invalid-pack" }
  | { outcome: "not-configured" }
  /** PayPal created the order but offered no page to approve it on. */
  | { outcome: "no-approve-url" };

/**
 * Starts a top-up for the signed-in viewer: the `credit_orders` row and the
 * PayPal order, inside the caller's transaction, so a failed create leaves no
 * row behind. Only a configured pack is accepted — the pack is a form field
 * anyone can edit.
 */
export async function startTopup(
  tx: TestDb,
  viewer: Viewer,
  packCents: number,
  opts: { client?: PayPalOrdersClient | null } = {},
): Promise<StartTopupResult> {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
  if (!Number.isInteger(packCents) || !topupPackCents().includes(packCents)) return { outcome: "invalid-pack" };
  const client = opts.client === undefined ? getPayPalOrdersClient() : opts.client;
  if (client === null) return { outcome: "not-configured" };

  const profile = await ensureProfile(tx, viewer);
  const [row] = await tx
    .insert(creditOrders)
    .values({ userId: profile.id, packCents })
    .returning({ id: creditOrders.id });
  const amount = creditTopupAmount(packCents);
  const order = await client.createOrder({
    customId: `${CREDIT_CUSTOM_ID_PREFIX}${row!.id}`,
    description: `${siteConfig.name} lead credit`,
    returnUrl: siteUrl(CREDIT_RETURN_PATH),
    cancelUrl: siteUrl(CREDIT_CANCELLED_PATH),
    purpose: "credit_topup",
    amount: { value: amount.value, currency: amount.currency_code },
  });
  await tx
    .update(creditOrders)
    .set({ providerOrderId: order.id, updatedAt: now() })
    .where(eq(creditOrders.id, row!.id));
  if (order.approveUrl === null) return { outcome: "no-approve-url" };
  return { outcome: "pay", approveUrl: order.approveUrl, orderId: order.id, creditOrderId: row!.id };
}

interface LockedOrder {
  readonly id: string;
  readonly userId: string;
  readonly packCents: number;
  readonly providerOrderId: string | null;
  readonly status: "created" | "captured" | "failed";
}

const orderColumns = {
  id: creditOrders.id,
  userId: creditOrders.userId,
  packCents: creditOrders.packCents,
  providerOrderId: creditOrders.providerOrderId,
  status: creditOrders.status,
};

async function lockOrderById(tx: TestDb, id: string): Promise<LockedOrder | null> {
  if (!UUID.test(id)) return null;
  const [row] = await tx.select(orderColumns).from(creditOrders).where(eq(creditOrders.id, id)).limit(1).for("update");
  return row ?? null;
}

async function lockOrderByProviderId(tx: TestDb, providerOrderId: string): Promise<LockedOrder | null> {
  const [row] = await tx
    .select(orderColumns)
    .from(creditOrders)
    .where(eq(creditOrders.providerOrderId, providerOrderId))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** A capture that must not credit anything, written down so the money can be found and refunded by hand. */
async function recordMismatch(
  tx: TestDb,
  row: LockedOrder,
  meta: { reason: "wrong-amount" | "order-mismatch"; providerOrderId: string | null; eventId: string | null; captureId: string | null; amount: CaptureAmount | null },
): Promise<void> {
  await writeAuditAs(tx, null, { action: "credit.payment.mismatch", entityType: "credit_order", entityId: row.id, meta });
}

/** Credits a captured order: ledger entry, row captured, audit, receipt. The caller holds the row lock. */
async function creditOrder(
  tx: TestDb,
  viewer: Viewer,
  row: LockedOrder,
  input: { providerOrderId: string; captureId: string | null; eventId: string | null },
): Promise<"credited" | "already-credited"> {
  const entry = await postLedger(tx, viewer, {
    userId: row.userId,
    deltaCents: row.packCents,
    kind: "topup",
    refType: "credit_order",
    refId: row.id,
    orderId: input.providerOrderId,
    note: "PayPal top-up",
  });
  await tx
    .update(creditOrders)
    .set({ status: "captured", capturedAt: now(), updatedAt: now() })
    .where(eq(creditOrders.id, row.id));
  if (entry === null) return "already-credited";
  await writeAuditAs(tx, null, {
    action: "credit.topped_up",
    entityType: "credit_order",
    entityId: row.id,
    meta: { userId: row.userId, cents: row.packCents, ...input },
  });
  await notifyCreditTopup(tx, viewer, row.id);
  return "credited";
}

export type TopupCaptureOutcome = "credited" | "already-credited" | "order-mismatch" | "failed-order";

/**
 * The webhook's half, called by `applyCaptureEvent` for a `credit:` custom_id.
 * Runs inside the webhook transaction with the billing system viewer.
 */
export async function applyTopupCapture(
  tx: TestDb,
  viewer: Viewer,
  input: { capture: CaptureEvent; creditOrderId: string; eventId: string },
): Promise<{ outcome: TopupCaptureOutcome | "unknown-order" | "wrong-amount"; creditOrderId?: string }> {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
  const { capture } = input;
  const row = await lockOrderById(tx, input.creditOrderId);
  if (row === null || row.providerOrderId === null) {
    console.warn(`[credits] capture ${capture.captureId} names credit order ${input.creditOrderId}, which this site does not hold`);
    return { outcome: "unknown-order" };
  }
  const ref = { creditOrderId: row.id };
  // Both ids present: they must agree, or the capture is for someone else's order.
  if (capture.orderId !== null && capture.orderId !== row.providerOrderId) {
    await recordMismatch(tx, row, { reason: "order-mismatch", providerOrderId: capture.orderId, eventId: input.eventId, captureId: capture.captureId, amount: capture.amount });
    return { outcome: "order-mismatch", ...ref };
  }
  if (row.status === "captured") {
    console.log(`[credits] capture ${capture.captureId} for credit order ${row.id}: already credited`);
    return { outcome: "already-credited", ...ref };
  }
  if (row.status === "failed") {
    console.warn(`[credits] capture ${capture.captureId} for failed credit order ${row.id}: ignored`);
    return { outcome: "failed-order", ...ref };
  }
  if (!amountMatches(capture.amount, creditTopupAmount(row.packCents))) {
    await recordMismatch(tx, row, { reason: "wrong-amount", providerOrderId: row.providerOrderId, eventId: input.eventId, captureId: capture.captureId, amount: capture.amount });
    await tx.update(creditOrders).set({ status: "failed", updatedAt: now() }).where(eq(creditOrders.id, row.id));
    return { outcome: "wrong-amount", ...ref };
  }
  const outcome = await creditOrder(tx, viewer, row, { providerOrderId: row.providerOrderId, captureId: capture.captureId, eventId: input.eventId });
  return { outcome, ...ref };
}

export type TopupSettleOutcome =
  | { outcome: "not-configured" }
  | { outcome: "unknown-order" }
  | { outcome: "credited"; creditOrderId: string; userId: string; cents: number }
  | { outcome: "already-credited"; creditOrderId: string; userId: string; cents: number }
  /** PayPal did not complete it, or it was for the wrong amount. Nothing credited; the webhook may still. */
  | { outcome: "not-completed"; creditOrderId: string; userId: string; status: string };

/**
 * The return page's half: capture the approved order and credit it, in the
 * caller's transaction so a completed capture and the ledger entry commit
 * together. Called with the billing system viewer; the page decides what the
 * signed-in buyer is shown.
 */
export async function settleTopupOrder(
  tx: TestDb,
  input: { client: PayPalOrdersClient | null; viewer: Viewer; orderId: string },
): Promise<TopupSettleOutcome> {
  if (!isAdmin(input.viewer)) throw new Error("FORBIDDEN");
  if (input.client === null) return { outcome: "not-configured" };

  const row = await lockOrderByProviderId(tx, input.orderId);
  if (row === null) return { outcome: "unknown-order" };
  const base = { creditOrderId: row.id, userId: row.userId };
  if (row.status === "captured") return { outcome: "already-credited", ...base, cents: row.packCents };
  if (row.status === "failed") return { outcome: "not-completed", ...base, status: "FAILED" };

  let captured: CapturedOrder;
  try {
    captured = await input.client.captureOrder(input.orderId);
  } catch (e) {
    console.error("[credits] capture failed:", e instanceof Error ? e.message : String(e));
    return { outcome: "not-completed", ...base, status: "UNAVAILABLE" };
  }
  if (captured.status !== "COMPLETED") return { outcome: "not-completed", ...base, status: captured.status };
  if (!amountMatches(captured.amount, creditTopupAmount(row.packCents))) {
    await recordMismatch(tx, row, { reason: "wrong-amount", providerOrderId: input.orderId, eventId: null, captureId: captured.captureId, amount: captured.amount });
    await tx.update(creditOrders).set({ status: "failed", updatedAt: now() }).where(eq(creditOrders.id, row.id));
    return { outcome: "not-completed", ...base, status: "AMOUNT_MISMATCH" };
  }
  const outcome = await creditOrder(tx, input.viewer, row, { providerOrderId: input.orderId, captureId: captured.captureId, eventId: null });
  return { outcome, ...base, cents: row.packCents };
}
