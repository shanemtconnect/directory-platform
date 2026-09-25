import { pgEnum } from "drizzle-orm/pg-core";

export const slugKind = pgEnum("slug_kind", [
  "static", "city", "vertical", "area", "category", "listing", "region",
]);
export const cityCreatedBy = pgEnum("city_created_by", ["seed", "admin", "auto"]);
export const userRole = pgEnum("user_role", ["user", "owner", "admin"]);

// 'removed' exists because a takedown request sets it. The brief's own enum
// omitted it while its prose relied on it.
export const listingStatus = pgEnum("listing_status", [
  "draft", "pending", "published", "rejected", "archived", "removed",
]);
export const listingTier = pgEnum("listing_tier", ["free", "essential", "premium"]);

// Ownership and payment are separate COLUMNS even though a paid subscription is
// what promotes claimed -> verified. Keeping them apart is what lets a listing
// be Claimed + Premium (paid, control not yet proven), or drop from Verified
// back to Claimed on cancellation without touching `tier`.
export const claimStatus = pgEnum("claim_status", ["unclaimed", "claimed", "verified"]);

// 'scraped' exists for the same reason as 'removed'.
export const listingSource = pgEnum("listing_source", [
  "seed", "admin", "public", "import", "scraped",
]);

export const claimRequestStatus = pgEnum("claim_request_status", [
  "pending", "approved", "rejected", "withdrawn",
]);
export const evidenceType = pgEnum("evidence_type", [
  "domain_email", "phone_otp", "document", "id_document",
]);
export const verificationStatus = pgEnum("verification_status", [
  "open", "docs_pending", "call_scheduled", "passed", "failed", "cancelled",
]);
export const billingInterval = pgEnum("billing_interval", ["monthly", "annual"]);
export const discountType = pgEnum("discount_type", ["percent", "fixed"]);
export const badgeStyle = pgEnum("badge_style", ["dark", "light", "compact", "rating"]);
export const reportReason = pgEnum("report_reason", [
  "incorrect", "closed", "duplicate", "offensive", "other",
]);
export const reportStatus = pgEnum("report_status", ["open", "actioned", "dismissed"]);
export const removalStatus = pgEnum("removal_status", ["open", "actioned", "rejected"]);
export const reviewStatus = pgEnum("review_status", [
  "pending", "published", "rejected", "disputed",
]);
export const jobStatus = pgEnum("job_status", ["pending", "published", "expired", "removed"]);
export const campaignChannel = pgEnum("campaign_channel", ["email", "sms"]);

/** What became of a broadcast quote request at one recipient. Owner-set. */
export const quoteOutcome = pgEnum("quote_outcome", ["open", "won", "lost"]);

/**
 * Where a quote request stands on the requester's verification link (Task 56).
 * Nobody is emailed and no lead is created until it is `verified`; `expired`
 * is set by the worker 48 hours after an unclicked link; `spam` is reserved
 * for moderation and is never set by the verification flow.
 */
export const quoteStatus = pgEnum("quote_status", ["pending", "verified", "expired", "spam"]);

/**
 * Pay-per-lead (Task 56). Declared here rather than in leads.ts because
 * `quote_requests.source` uses `lead_source` too, and modules.ts importing
 * from leads.ts (which imports modules.ts) would be a cycle evaluated before
 * the enum exists.
 */
export const leadSource = pgEnum("lead_source", ["quote", "capture", "enquiry"]);
export const leadStatus = pgEnum("lead_status", ["open", "sold", "expired", "deleted"]);
export const blocklistKind = pgEnum("blocklist_kind", ["phone", "email"]);
