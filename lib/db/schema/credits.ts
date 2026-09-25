import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index, pgEnum } from "drizzle-orm/pg-core";
import { base } from "./_base";
import { profiles } from "./ownership";

/**
 * Prepaid lead credit (Task 57, flag `leadMarketplace`).
 *
 * The ledger is append-only and the balance is its sum: there is no balance
 * column to drift out of step with the rows that explain it. Amounts are
 * minor units of `siteConfig.currency`. `order_id` is the PayPal order a
 * top-up settled, and its unique index is what makes "the webhook and the
 * return page both settle it" credit the account exactly once.
 */
export const creditKind = pgEnum("credit_kind", ["topup", "purchase", "refund", "adjust"]);
export const creditOrderStatus = pgEnum("credit_order_status", ["created", "captured", "failed"]);

export const creditLedger = pgTable("credit_ledger", {
  ...base,
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  deltaCents: integer("delta_cents").notNull(),
  kind: creditKind("kind").notNull(),
  /** What the entry is about: 'credit_order', 'lead', 'lead_refund'. Null for an adjustment. */
  refType: text("ref_type"),
  refId: uuid("ref_id"),
  note: text("note"),
  /** The PayPal order a top-up came from. Unique: one order credits once. */
  orderId: text("order_id"),
  /** profiles.id of the admin behind an adjustment; null for the system. */
  createdBy: uuid("created_by"),
}, (t) => [
  index("credit_ledger_user_idx").on(t.userId, t.createdAt),
  uniqueIndex("credit_ledger_order_key").on(t.orderId),
]);

export const creditOrders = pgTable("credit_orders", {
  ...base,
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  packCents: integer("pack_cents").notNull(),
  /** Null only between the row insert and the PayPal create, inside one transaction. */
  providerOrderId: text("provider_order_id"),
  status: creditOrderStatus("status").notNull().default("created"),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("credit_orders_provider_order_key").on(t.providerOrderId),
  index("credit_orders_user_idx").on(t.userId),
]);
