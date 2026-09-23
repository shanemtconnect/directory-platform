import { sql } from "drizzle-orm";
import {
  pgTable, pgEnum, uuid, text, integer, timestamp, date, index, uniqueIndex, check,
} from "drizzle-orm/pg-core";
import { base } from "./_base";
import { profiles } from "./ownership";

/**
 * Sponsor rails (Task 43): house ads plus self-serve sponsors. No ad network,
 * ever — every row here is a campaign somebody on this site wrote and an
 * admin approved.
 */

export const sponsorCampaignStatus = pgEnum("sponsor_campaign_status", [
  "pending", "active", "paused", "ended", "rejected",
]);

/** Where the campaign's PayPal subscription stands. `none` = no billing attached. */
export const SPONSOR_BILLING_STATUSES = [
  "none", "approval_pending", "active", "past_due", "cancelled", "suspended", "expired",
] as const;
export type SponsorBillingStatus = (typeof SPONSOR_BILLING_STATUSES)[number];

export const SPONSOR_TITLE_MAX = 60;
export const SPONSOR_BLURB_MAX = 120;

export const sponsorCampaigns = pgTable("sponsor_campaigns", {
  ...base,
  /** The advertiser — a `profiles.id`, never a Better Auth user id (constraint 21). */
  advertiserId: uuid("advertiser_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  /** The advertiser's business name; shown as the logo's alt text and the initial fallback. */
  name: text("name").notNull(),
  /** R2 key under the media bucket, or null when no logo was stored. */
  logoPath: text("logo_path"),
  title: text("title").notNull(),
  blurb: text("blurb").notNull(),
  targetUrl: text("target_url").notNull(),
  status: sponsorCampaignStatus("status").notNull().default("pending"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  /** PayPal subscription id (text, not a `subscriptions` row: those require a listing). */
  subscriptionId: text("subscription_id"),
  billingStatus: text("billing_status").notNull().default("none"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  /** Which placements (config/types.ts AD_PLACEMENTS) it may show on. */
  placements: text("placements").array().notNull().default(sql`'{}'::text[]`),
  weight: integer("weight").notNull().default(1),
  rejectionReason: text("rejection_reason"),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => [
  index("sponsor_campaigns_status_idx").on(t.status),
  index("sponsor_campaigns_advertiser_idx").on(t.advertiserId),
  uniqueIndex("sponsor_campaigns_subscription_key").on(t.subscriptionId),
  check("sponsor_campaigns_title_len", sql`char_length(${t.title}) <= ${sql.raw(String(SPONSOR_TITLE_MAX))}`),
  check("sponsor_campaigns_blurb_len", sql`char_length(${t.blurb}) <= ${sql.raw(String(SPONSOR_BLURB_MAX))}`),
  check("sponsor_campaigns_weight_check", sql`${t.weight} >= 1`),
  check(
    "sponsor_campaigns_billing_status_check",
    sql`${t.billingStatus} in ('none', 'approval_pending', 'active', 'past_due', 'cancelled', 'suspended', 'expired')`,
  ),
]);

/** Impressions and clicks per campaign per day, flushed from Redis by the worker. */
export const sponsorStatsDaily = pgTable("sponsor_stats_daily", {
  ...base,
  campaignId: uuid("campaign_id").notNull().references(() => sponsorCampaigns.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  impressions: integer("impressions").notNull().default(0),
  clicks: integer("clicks").notNull().default(0),
}, (t) => [uniqueIndex("sponsor_stats_daily_key").on(t.campaignId, t.day)]);
