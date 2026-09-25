import { sql } from "drizzle-orm";
import {
  pgEnum, pgTable, uuid, text, jsonb, boolean, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { base } from "./_base";
import { profiles } from "./ownership";

/**
 * Saved searches and their email alerts (Task 54, flag `savedSearches`).
 *
 * A signed-in person saves the search they are looking at — the listings
 * search on /search or the jobs board — and the worker emails a digest of
 * what is NEW since the last one. The table ships on every site; the flag
 * decides whether anything reads it.
 */

/** Which query `params` is fed back into: `search()` or the jobs board's `listOpenJobs()`. */
export const savedSearchKind = pgEnum("saved_search_kind", ["listings", "jobs"]);
export const savedSearchFrequency = pgEnum("saved_search_frequency", ["daily", "weekly"]);

export const savedSearches = pgTable("saved_searches", {
  ...base,
  /** Named `user_id` for the brief's sake; it references `profiles.id`, like every other "who" column. */
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  kind: savedSearchKind("kind").notNull(),
  /**
   * The query's own parameters, passed back to it untouched. Opaque here on
   * purpose: the search grows filters (Task 53's `verified`) without this
   * table or its code having to learn them.
   */
  params: jsonb("params").$type<Record<string, unknown>>().notNull(),
  /** sha256 of the canonical JSON of `params` — what makes "the same search saved twice" one row. */
  paramsHash: text("params_hash").notNull(),
  /** What the person sees in the account list and the email subject. */
  label: text("label").notNull(),
  frequency: savedSearchFrequency("frequency").notNull().default("weekly"),
  /** When the last digest went. Null: never, so the search is due at the next check. */
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  /**
   * The watermark: the newest `created_at` a digest has covered. Set to the
   * moment of saving, so the first digest is what arrived AFTER the save and
   * not the whole back catalogue.
   */
  lastSeenCreatedAt: timestamp("last_seen_created_at", { withTimezone: true }).notNull().defaultNow(),
  /** False once the one-click unsubscribe is used. Saving the same search again turns it back on. */
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [
  uniqueIndex("saved_searches_user_kind_params_key").on(t.userId, t.kind, t.paramsHash),
  // The hourly dispatch reads active rows only.
  index("saved_searches_active_idx").on(t.lastSentAt).where(sql`${t.isActive}`),
]);
