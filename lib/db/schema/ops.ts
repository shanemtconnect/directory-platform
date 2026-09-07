import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb, date,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { base } from "./_base";
import { badgeStyle } from "./enums";
import { listings } from "./listings";

/** Any slug change writes a row here and serves a 301. Never break a URL. */
export const redirects = pgTable("redirects", {
  ...base,
  fromPath: text("from_path").notNull(),
  toPath: text("to_path").notNull(),
  statusCode: integer("status_code").notNull().default(301),
}, (t) => [uniqueIndex("redirects_from_key").on(t.fromPath)]);

export const auditLog = pgTable("audit_log", {
  ...base,
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  meta: jsonb("meta"),
  ip: text("ip"),
}, (t) => [index("audit_log_entity_idx").on(t.entityType, t.entityId)]);

export const jobRuns = pgTable("job_runs", {
  ...base,
  jobName: text("job_name").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull(),
  error: text("error"),
  lockKey: text("lock_key"),
}, (t) => [index("job_runs_name_idx").on(t.jobName, t.startedAt)]);

/** Feeds the owner ROI dashboard — the renewal argument is a number, not a feeling. */
export const listingStatsDaily = pgTable("listing_stats_daily", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  views: integer("views").notNull().default(0),
  impressions: integer("impressions").notNull().default(0),
  enquiries: integer("enquiries").notNull().default(0),
  shortlistAdds: integer("shortlist_adds").notNull().default(0),
  badgeClicks: integer("badge_clicks").notNull().default(0),
}, (t) => [uniqueIndex("listing_stats_daily_key").on(t.listingId, t.day)]);

export const badges = pgTable("badges", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  style: badgeStyle("style").notNull().default("dark"),
  snippetHtml: text("snippet_html"),
  backlinkUrl: text("backlink_url"),
  backlinkVerified: boolean("backlink_verified").notNull().default(false),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  impressionCount: integer("impression_count").notNull().default(0),
  clickCount: integer("click_count").notNull().default(0),
}, (t) => [index("badges_listing_idx").on(t.listingId)]);
