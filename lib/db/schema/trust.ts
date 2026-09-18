import { pgTable, uuid, text, boolean, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { base } from "./_base";
import { reportReason, reportStatus, removalStatus } from "./enums";
import { listings } from "./listings";

export const enquiries = pgTable("enquiries", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  message: text("message"),
  isSpam: boolean("is_spam").notNull().default(false),
  readAt: timestamp("read_at", { withTimezone: true }),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  /** Feeds the honest "usually replies within N hours" figure on the listing. */
  respondedInMinutes: integer("responded_in_minutes"),
  ip: text("ip"),
}, (t) => [index("enquiries_listing_idx").on(t.listingId)]);

/** "Report incorrect information" — a free data-cleaning queue. */
export const reports = pgTable("reports", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  reason: reportReason("reason").notNull(),
  detail: text("detail"),
  reporterEmail: text("reporter_email"),
  status: reportStatus("status").notNull().default("open"),
  ip: text("ip"),
}, (t) => [index("reports_status_idx").on(t.status)]);

/** One-click removal on every unclaimed listing. 5-working-day SLA. */
export const removalRequests = pgTable("removal_requests", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  requesterName: text("requester_name"),
  requesterEmail: text("requester_email"),
  relationship: text("relationship"),
  reason: text("reason"),
  status: removalStatus("status").notNull().default("open"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  actionedBy: uuid("actioned_by"),
  actionedAt: timestamp("actioned_at", { withTimezone: true }),
  /**
   * Why a request was turned down, in the moderator's words. Required on a
   * rejection and repeated to the requester: a "no" with no reason is the one
   * answer that reads as no answer at all. Null on a takedown and on rows
   * decided before the column existed.
   */
  rejectionReason: text("rejection_reason"),
}, (t) => [index("removal_requests_status_idx").on(t.status, t.dueAt)]);

/** A later import can never resurrect a listing someone asked us to remove. */
export const suppressions = pgTable("suppressions", {
  ...base,
  nameNormalised: text("name_normalised").notNull(),
  postcodeNormalised: text("postcode_normalised"),
  email: text("email"),
  phone: text("phone"),
  reason: text("reason"),
  createdBy: uuid("created_by"),
}, (t) => [index("suppressions_name_postcode_idx").on(t.nameNormalised, t.postcodeNormalised)]);
