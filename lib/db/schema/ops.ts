import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb, date,
  uniqueIndex, index, check,
} from "drizzle-orm/pg-core";
import { base } from "./_base";
import { badgeStyle } from "./enums";
import { listings } from "./listings";

/**
 * Any slug change writes a row here and serves a 301. Never break a URL.
 *
 * The router serves five status codes and nothing else, so the database refuses
 * the rest: a row the router cannot act on is a URL quietly serving the wrong
 * thing. 410 is the tombstone for a URL that is gone rather than moved — such a
 * row stores its own path in `to_path`, since there is nowhere to send anyone.
 */
export const redirects = pgTable("redirects", {
  ...base,
  fromPath: text("from_path").notNull(),
  toPath: text("to_path").notNull(),
  statusCode: integer("status_code").notNull().default(301),
}, (t) => [
  uniqueIndex("redirects_from_key").on(t.fromPath),
  check("redirects_status_code_check", sql`${t.statusCode} in (301, 302, 307, 308, 410)`),
]);

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

/**
 * The durable job queue. Distinct from `job_runs`, which is the log of what the
 * cron ticks did: this is the work itself, enqueued by a request and executed
 * later. Notifications go through it because a mail provider must never be on
 * the request path — an enquiry is saved whether or not Resend is reachable,
 * and the email is retried until it lands or the queue gives up on it.
 *
 * `run_after` is both the schedule and the retry backoff. `attempts` and
 * `last_error` are what stop a permanently broken job costing a provider call
 * every thirty seconds for ever.
 */
export const jobQueue = pgTable("job_queue", {
  ...base,
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /**
   * The recipient keys this job has already reached, so a retry re-sends only
   * what failed. Without it one mistyped admin address means the owner of a
   * claimed listing gets the same enquiry once per attempt.
   */
  delivered: jsonb("delivered").$type<string[]>().notNull().default([]),
}, (t) => [
  index("job_queue_claim_idx").on(t.status, t.runAfter),
  // A status the claim query cannot match is work that silently never runs.
  check("job_queue_status_check", sql`${t.status} in ('pending', 'done', 'failed')`),
  check("job_queue_attempts_check", sql`${t.attempts} >= 0`),
]);
