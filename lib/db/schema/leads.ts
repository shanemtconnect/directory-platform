import {
  pgTable, uuid, text, integer, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { base } from "./_base";
import { blocklistKind, leadSource, leadStatus } from "./enums";
import { user } from "./auth";
import { cities, categories } from "./geo";
import { listings } from "./listings";
import { quoteRequests } from "./modules";

/**
 * Pay-per-lead (flag `leadMarketplace`, Task 56 supply side).
 *
 * A LEAD is a verified request for work that no paying local listing
 * received: a quote request that reached only free listings (or none), a
 * lead-capture box on the home page or a rail, or an enquiry to an unclaimed
 * listing we hold no address for (D5). It is created open, at the floor
 * price, and Task 58 sells it — to a standing order, or from the board.
 *
 * The contact fields live here and nowhere a buyer can see before paying:
 * the board shows `first_name` and `brief`, and `brief` is generated with
 * the email, phone, surname and postcode stripped (`briefFor`).
 */
export const leads = pgTable("leads", {
  ...base,
  source: leadSource("source").notNull(),
  quoteRequestId: uuid("quote_request_id").references(() => quoteRequests.id, { onDelete: "set null" }),
  /** The enquiry's target, for `source = 'enquiry'`. */
  listingId: uuid("listing_id").references(() => listings.id, { onDelete: "set null" }),
  cityId: uuid("city_id").notNull().references(() => cities.id),
  categoryId: uuid("category_id").references(() => categories.id),
  firstName: text("first_name").notNull(),
  /** ≤ 160 characters, contact details stripped. What the board shows. */
  brief: text("brief").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  /** E.164, from `normalisePhone`. The duplicate and blocklist key. */
  phoneNormalised: text("phone_normalised"),
  /** Lower-cased, trimmed. The duplicate and blocklist key. */
  emailNormalised: text("email_normalised").notNull(),
  message: text("message").notNull(),
  status: leadStatus("status").notNull().default("open"),
  /** `siteConfig.leads.floor` in minor units at creation. */
  priceCents: integer("price_cents").notNull(),
  soldAt: timestamp("sold_at", { withTimezone: true }),
  soldToListingId: uuid("sold_to_listing_id").references(() => listings.id, { onDelete: "set null" }),
  buyerUserId: text("buyer_user_id").references(() => user.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  halfPriceAt: timestamp("half_price_at", { withTimezone: true }).notNull(),
}, (t) => [
  index("leads_status_city_idx").on(t.status, t.cityId),
  index("leads_phone_idx").on(t.phoneNormalised),
  index("leads_email_idx").on(t.emailNormalised),
]);

/**
 * Phones and emails a lead may not come from. Written by Task 58's refund
 * approval (12 months) and by an admin; read by `checkLeadRules`. `value` is
 * the normalised form — E.164 for a phone, lower-cased for an email — so a
 * reformatted number is still the same number.
 */
export const leadBlocklist = pgTable("lead_blocklist", {
  ...base,
  kind: blocklistKind("kind").notNull(),
  value: text("value").notNull(),
  reason: text("reason").notNull(),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  /** Null = permanent. Past = no longer blocks. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [uniqueIndex("lead_blocklist_key").on(t.kind, t.value)]);
