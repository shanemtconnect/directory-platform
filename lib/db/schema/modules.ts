import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb, numeric,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { base } from "./_base";
import { reviewStatus, jobStatus, campaignChannel } from "./enums";
import { listings } from "./listings";
import { cities, categories } from "./geo";

// Every table below ships on every site regardless of feature flags.
// Conditional migrations create drift between clones; an unused table is free.

export const reviews = pgTable("reviews", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  authorEmail: text("author_email").notNull(),
  authorDisplayName: text("author_display_name"),
  rating: integer("rating").notNull(),
  subRatings: jsonb("sub_ratings"),
  title: text("title"),
  body: text("body"),
  status: reviewStatus("status").notNull().default("pending"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  flaggedReason: text("flagged_reason"),
  ip: text("ip"),
}, (t) => [
  // One review per email per listing.
  uniqueIndex("reviews_listing_author_key").on(t.listingId, t.authorEmail),
  index("reviews_status_idx").on(t.status),
]);

export const reviewPhotos = pgTable("review_photos", {
  ...base,
  reviewId: uuid("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  storagePath: text("storage_path").notNull(),
  derivatives: jsonb("derivatives"),
  alt: text("alt"),
});

export const reviewReplies = pgTable("review_replies", {
  ...base,
  reviewId: uuid("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  authorId: uuid("author_id"),
  body: text("body").notNull(),
  status: reviewStatus("status").notNull().default("pending"),
}, (t) => [uniqueIndex("review_replies_review_key").on(t.reviewId)]);

/** Shareable link + QR the business sends to real customers. Never seeded. */
export const reviewInvites = pgTable("review_invites", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  sentTo: text("sent_to"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  usedAt: timestamp("used_at", { withTimezone: true }),
}, (t) => [uniqueIndex("review_invites_token_key").on(t.token)]);

export const shortlists = pgTable("shortlists", {
  ...base,
  userId: uuid("user_id"),
  /** Logged-out lists live on a cookie and merge into the account on signup. */
  cookieId: text("cookie_id"),
  name: text("name"),
  shareId: text("share_id").notNull(),
  isPublic: boolean("is_public").notNull().default(false),
}, (t) => [uniqueIndex("shortlists_share_key").on(t.shareId)]);

export const shortlistItems = pgTable("shortlist_items", {
  ...base,
  shortlistId: uuid("shortlist_id").notNull().references(() => shortlists.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  note: text("note"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [uniqueIndex("shortlist_items_key").on(t.shortlistId, t.listingId)]);

/** Cost guides. No page goes live without a real number and a cited source. */
export const priceData = pgTable("price_data", {
  ...base,
  service: text("service").notNull(),
  cityId: uuid("city_id").references(() => cities.id),
  low: numeric("low", { precision: 10, scale: 2 }),
  median: numeric("median", { precision: 10, scale: 2 }),
  high: numeric("high", { precision: 10, scale: 2 }),
  sampleSize: integer("sample_size").notNull().default(0),
  currency: text("currency"),
  methodologyNote: text("methodology_note"),
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
}, (t) => [uniqueIndex("price_data_service_city_key").on(t.service, t.cityId)]);

export const quoteRequests = pgTable("quote_requests", {
  ...base,
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  message: text("message"),
  cityId: uuid("city_id").references(() => cities.id),
  categoryId: uuid("category_id").references(() => categories.id),
  ip: text("ip"),
});

export const quoteRecipients = pgTable("quote_recipients", {
  ...base,
  quoteRequestId: uuid("quote_request_id").notNull().references(() => quoteRequests.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  /** Free tiers get the enquiry with contact details masked — the upgrade prompt. */
  contactMasked: boolean("contact_masked").notNull().default(true),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
}, (t) => [uniqueIndex("quote_recipients_key").on(t.quoteRequestId, t.listingId)]);

export const jobs = pgTable("jobs", {
  ...base,
  title: text("title").notNull(),
  description: text("description"),
  cityId: uuid("city_id").references(() => cities.id),
  categoryId: uuid("category_id").references(() => categories.id),
  budgetMin: numeric("budget_min", { precision: 10, scale: 2 }),
  budgetMax: numeric("budget_max", { precision: 10, scale: 2 }),
  posterEmail: text("poster_email"),
  status: jobStatus("status").notNull().default("pending"),
  /** Expired jobs 410 rather than 404, so dead pages do not accumulate. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [index("jobs_status_idx").on(t.status, t.expiresAt)]);

export const jobApplications = pgTable("job_applications", {
  ...base,
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  message: text("message"),
}, (t) => [uniqueIndex("job_applications_key").on(t.jobId, t.listingId)]);

/** Threshold-based and published. Never editorial, never for sale. */
export const awards = pgTable("awards", {
  ...base,
  year: integer("year").notNull(),
  cityId: uuid("city_id").references(() => cities.id),
  categoryId: uuid("category_id").references(() => categories.id),
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  rank: integer("rank"),
  methodologyVersion: text("methodology_version"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (t) => [index("awards_year_idx").on(t.year, t.cityId, t.categoryId)]);

export const affiliates = pgTable("affiliates", {
  ...base,
  userId: uuid("user_id"),
  code: text("code").notNull(),
  commissionPct: numeric("commission_pct", { precision: 5, scale: 2 }),
  status: text("status").notNull().default("active"),
}, (t) => [uniqueIndex("affiliates_code_key").on(t.code)]);

export const referrals = pgTable("referrals", {
  ...base,
  affiliateId: uuid("affiliate_id").notNull().references(() => affiliates.id),
  subscriptionId: uuid("subscription_id"),
  amount: numeric("amount", { precision: 10, scale: 2 }),
  status: text("status").notNull().default("pending"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export const campaigns = pgTable("campaigns", {
  ...base,
  name: text("name").notNull(),
  segment: jsonb("segment"),
  channel: campaignChannel("channel").notNull().default("email"),
  templateKey: text("template_key"),
  status: text("status").notNull().default("draft"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentCount: integer("sent_count").notNull().default(0),
  openedCount: integer("opened_count").notNull().default(0),
  claimedCount: integer("claimed_count").notNull().default(0),
  convertedCount: integer("converted_count").notNull().default(0),
});

export const campaignMessages = pgTable("campaign_messages", {
  ...base,
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  toAddress: text("to_address").notNull(),
  magicToken: text("magic_token"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  clickedAt: timestamp("clicked_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
}, (t) => [
  index("campaign_messages_campaign_idx").on(t.campaignId),
  // The magic token is a BEARER CREDENTIAL — whoever holds it can open a claim
  // on the listing it names. A collision would hand one recipient another
  // business's listing, and 32 bytes of CSPRNG is a reason to expect that
  // never to happen, not a guarantee that it cannot. Nullable, so a channel
  // with no magic link is unaffected: Postgres does not compare NULLs.
  uniqueIndex("campaign_messages_magic_token_key").on(t.magicToken),
]);

/** One unsubscribe means one unsubscribe forever, across every campaign. */
export const unsubscribes = pgTable("unsubscribes", {
  ...base,
  addressNormalised: text("address_normalised").notNull(),
  reason: text("reason"),
}, (t) => [uniqueIndex("unsubscribes_address_key").on(t.addressNormalised)]);
