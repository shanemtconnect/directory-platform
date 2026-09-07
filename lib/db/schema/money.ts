import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb, numeric,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { base } from "./_base";
import { listingTier, billingInterval, discountType } from "./enums";
import { listings } from "./listings";

/**
 * Provider-neutral column names. PayPal is the decided provider (Stripe is
 * region-blocked for a Jersey seller); a future move changes lib/billing/ and
 * not a migration.
 */
export const subscriptions = pgTable("subscriptions", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  userId: uuid("user_id"),
  provider: text("provider").notNull().default("paypal"),
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  providerPlanId: text("provider_plan_id"),
  tier: listingTier("tier").notNull(),
  interval: billingInterval("interval").notNull(),
  status: text("status").notNull(),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
}, (t) => [
  index("subscriptions_listing_idx").on(t.listingId),
  uniqueIndex("subscriptions_provider_sub_key").on(t.providerSubscriptionId),
]);

/**
 * PayPal has no promotion-code primitive for subscriptions, so this table is
 * the enforcer rather than a reporting mirror. Redemption counting, expiry and
 * eligibility are all ours; the discount reaches PayPal as a plan override at
 * subscription-creation time.
 */
export const coupons = pgTable("coupons", {
  ...base,
  code: text("code").notNull(),
  description: text("description"),
  discountType: discountType("discount_type").notNull(),
  value: numeric("value", { precision: 10, scale: 2 }).notNull(),
  appliesToTiers: text("applies_to_tiers").array(),
  appliesToIntervals: text("applies_to_intervals").array(),
  maxRedemptions: integer("max_redemptions"),
  redemptionCount: integer("redemption_count").notNull().default(0),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by"),
  /** Groups a bulk generation run so 50 outreach codes export together. */
  batchId: uuid("batch_id"),
}, (t) => [
  uniqueIndex("coupons_code_key").on(t.code),
  index("coupons_batch_idx").on(t.batchId),
]);

export const couponRedemptions = pgTable("coupon_redemptions", {
  ...base,
  couponId: uuid("coupon_id").notNull().references(() => coupons.id),
  userId: uuid("user_id"),
  listingId: uuid("listing_id").references(() => listings.id),
  subscriptionId: uuid("subscription_id").references(() => subscriptions.id),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("coupon_redemptions_coupon_idx").on(t.couponId)]);

/** The unique constraint IS the webhook idempotency mechanism, not a nicety. */
export const processedEvents = pgTable("processed_events", {
  ...base,
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload"),
}, (t) => [uniqueIndex("processed_events_event_key").on(t.provider, t.eventId)]);
