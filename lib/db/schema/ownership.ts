import { pgTable, uuid, text, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { base } from "./_base";
import { userRole, claimRequestStatus, evidenceType, verificationStatus } from "./enums";
import { listings } from "./listings";
import { user } from "./auth";

export const profiles = pgTable("profiles", {
  ...base,
  /**
   * Cascades on user deletion. Without the FK a deleted account leaves an
   * orphaned profile behind — and if that row said role 'admin', a later user
   * issued the same id would inherit it.
   */
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: userRole("role").notNull().default("user"),
  name: text("name"),
  phone: text("phone"),
  billingCustomerId: text("billing_customer_id"),
  marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
  /** The weekly lead-board digest (Task 58): off by its unsubscribe link or the account page. */
  leadDigestOptOut: boolean("lead_digest_opt_out").notNull().default(false),
}, (t) => [uniqueIndex("profiles_user_key").on(t.userId)]);

export const claims = pgTable("claims", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  userId: uuid("user_id"),
  status: claimRequestStatus("status").notNull().default("pending"),
  claimantName: text("claimant_name"),
  roleAtBusiness: text("role_at_business"),
  businessEmail: text("business_email"),
  businessPhone: text("business_phone"),
  evidenceType: evidenceType("evidence_type"),
  evidenceNotes: text("evidence_notes"),
  // Private bucket only. Reachable solely via a 15-minute presigned URL from an
  // admin route, and purged 30 days after the decision.
  idDocumentPath: text("id_document_path"),
  proofDocumentPath: text("proof_document_path"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
  /** Drops an outreach recipient straight into the right claim, pre-matched. */
  magicToken: text("magic_token"),
  magicTokenExpiresAt: timestamp("magic_token_expires_at", { withTimezone: true }),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  adminNotes: text("admin_notes"),
  rejectionReason: text("rejection_reason"),
  documentsPurgedAt: timestamp("documents_purged_at", { withTimezone: true }),
  ip: text("ip"),
  userAgent: text("user_agent"),
}, (t) => [
  index("claims_listing_idx").on(t.listingId),
  index("claims_status_idx").on(t.status),
  uniqueIndex("claims_magic_token_key").on(t.magicToken),
]);

/**
 * Opened when a subscription activates. Verified requires BOTH an active
 * subscription AND a passed check — there is no fee column, because the check
 * is bundled and there is nothing separate to charge for.
 */
export const verificationChecks = pgTable("verification_checks", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id"),
  userId: uuid("user_id"),
  status: verificationStatus("status").notNull().default("open"),
  evidenceType: evidenceType("evidence_type"),
  checklist: jsonb("checklist"),
  callScheduledAt: timestamp("call_scheduled_at", { withTimezone: true }),
  signedOffBy: uuid("signed_off_by"),
  signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
  notes: text("notes"),
}, (t) => [
  index("verification_checks_listing_idx").on(t.listingId),
  index("verification_checks_status_idx").on(t.status),
]);
