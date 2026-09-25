import { pgTable, pgEnum, uuid, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { base } from "./_base";
import { profiles } from "./ownership";
import { listings } from "./listings";
import { leads } from "./leads";

/**
 * The lead market (Task 58, flag `leadMarketplace`): who buys a lead, and
 * what happens when it was a bad one.
 *
 *  - A STANDING ORDER is a listing's instruction to buy every lead in its
 *    territories and categories at `price_cents`. Allocation
 *    (lib/leads/allocate.ts) gives each new lead to the best-paying order
 *    that can afford it — one buyer per lead.
 *  - A PURCHASE is the sale: one row per lead (unique), whether the lead
 *    went to a standing order or was bought off the board.
 *  - A REFUND is the buyer's report of a bad lead (D10): credit only,
 *    admin-decided, at most one per purchase.
 *
 * `user_id` everywhere here is `profiles.id`, the key the credit ledger uses.
 */

export const standingOrderStatus = pgEnum("standing_order_status", ["active", "paused"]);

/** D10: the only reasons a lead is refunded. Everything else is printed on the board as no-refund. */
export const leadRefundReason = pgEnum("lead_refund_reason", [
  "dead_phone", "wrong_person", "bounced", "spam", "never_asked", "wrong_area",
]);
export const leadRefundStatus = pgEnum("lead_refund_status", ["pending", "approved", "rejected"]);

/**
 * Where a standing order buys. `city` holds a city uuid, `region` the
 * region's slug (`regionSlug(cities.region)`), `national` nothing.
 */
export type Territory =
  | { readonly kind: "city"; readonly id: string }
  | { readonly kind: "region"; readonly id: string }
  | { readonly kind: "national" };

export const leadStandingOrders = pgTable("lead_standing_orders", {
  ...base,
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  territories: jsonb("territories").$type<Territory[]>().notNull(),
  /** Null = every category. */
  categoryIds: jsonb("category_ids").$type<string[] | null>(),
  /** What one lead costs this order, minor units, ≥ `siteConfig.leads.floor`. */
  priceCents: integer("price_cents").notNull(),
  status: standingOrderStatus("status").notNull().default("active"),
  /** `no_credit` (allocation paused it) or `user` (the owner did). Null while active. */
  pausedReason: text("paused_reason"),
  wonCount: integer("won_count").notNull().default(0),
}, (t) => [
  index("lead_standing_orders_status_idx").on(t.status),
  index("lead_standing_orders_listing_idx").on(t.listingId),
]);

export const leadPurchases = pgTable("lead_purchases", {
  ...base,
  leadId: uuid("lead_id").notNull().references(() => leads.id),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").references(() => listings.id, { onDelete: "set null" }),
  /** Null when the lead was bought off the board. */
  standingOrderId: uuid("standing_order_id").references(() => leadStandingOrders.id, { onDelete: "set null" }),
  priceCents: integer("price_cents").notNull(),
  /** The `credit_ledger` purchase entry that paid for it. */
  ledgerId: uuid("ledger_id").notNull(),
  /** When the contact details were handed over (the page or the won email). */
  revealedAt: timestamp("revealed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("lead_purchases_lead_key").on(t.leadId),
  index("lead_purchases_user_idx").on(t.userId, t.createdAt),
]);

export const leadRefunds = pgTable("lead_refunds", {
  ...base,
  purchaseId: uuid("purchase_id").notNull().references(() => leadPurchases.id, { onDelete: "cascade" }),
  reason: leadRefundReason("reason").notNull(),
  note: text("note"),
  status: leadRefundStatus("status").notNull().default("pending"),
  /** profiles.id of the admin who decided. */
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
}, (t) => [
  uniqueIndex("lead_refunds_purchase_key").on(t.purchaseId),
  index("lead_refunds_status_idx").on(t.status),
]);
