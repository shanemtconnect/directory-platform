import { isUuid, normaliseBody, stripCrlf } from "@/lib/actions/validation";

/**
 * What the two claim forms are allowed to send.
 *
 * Outside the "use server" module for the same reason the enquiry validation
 * is: an action module may only export async functions, and validation nobody
 * can unit test is validation nobody checks.
 */

type Result<T> = { values: T; errors?: undefined } | { values?: undefined; errors: Record<string, string> };

const MAX = { email: 254, name: 120, role: 120, notes: 1000 } as const;

/**
 * Five an hour, per connection.
 *
 * Each domain claim sends an email to an address the sender chose, which is the
 * shape of an open relay if it is not counted. Five is room for a mistyped
 * address and a resend, and nothing like enough to use us to mail somebody.
 */
export const CLAIM_RATE_LIMIT = { limit: 5, windowSeconds: 3600 } as const;

function field(form: FormData, key: string): string {
  return stripCrlf(String(form.get(key) ?? "")).trim();
}

export interface DomainClaimValues {
  listingId: string;
  businessEmail: string;
  claimantName: string | null;
  roleAtBusiness: string | null;
}

export function validateDomainClaim(form: FormData): Result<DomainClaimValues> {
  const errors: Record<string, string> = {};
  const listingId = field(form, "listingId");
  const businessEmail = field(form, "businessEmail");
  const claimantName = field(form, "claimantName");
  const roleAtBusiness = field(form, "roleAtBusiness");

  // Hidden field: a bad value is a tampered form or a bot, never a typo.
  if (!isUuid(listingId)) errors.listingId = "That listing could not be found.";
  // Same permissive shape as the enquiry form. Whether the address works is
  // settled by whether the link arrives, not by a regex.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(businessEmail)) {
    errors.businessEmail = "Please give a valid email address.";
  }
  if (businessEmail.length > MAX.email) errors.businessEmail = "That email address is too long.";
  if (claimantName.length > MAX.name) errors.claimantName = "That name is too long.";
  if (roleAtBusiness.length > MAX.role) errors.roleAtBusiness = "That is too long.";

  if (Object.keys(errors).length > 0) return { errors };
  return {
    values: {
      listingId,
      businessEmail,
      claimantName: claimantName || null,
      roleAtBusiness: roleAtBusiness || null,
    },
  };
}

export interface DocumentClaimValues {
  listingId: string;
  claimantName: string;
  roleAtBusiness: string | null;
  evidenceNotes: string | null;
}

export function validateDocumentClaim(form: FormData): Result<DocumentClaimValues> {
  const errors: Record<string, string> = {};
  const listingId = field(form, "listingId");
  const claimantName = field(form, "claimantName");
  const roleAtBusiness = field(form, "roleAtBusiness");
  // Notes are read by a person alongside the document, so paragraph breaks the
  // claimant typed on purpose survive.
  const evidenceNotes = normaliseBody(String(form.get("evidenceNotes") ?? "")).trim();

  if (!isUuid(listingId)) errors.listingId = "That listing could not be found.";
  // A document claim is decided by a human, and "who are you" is the first
  // thing they need.
  if (claimantName.length < 2) errors.claimantName = "Please give your name.";
  if (claimantName.length > MAX.name) errors.claimantName = "That name is too long.";
  if (roleAtBusiness.length > MAX.role) errors.roleAtBusiness = "That is too long.";
  if (evidenceNotes.length > MAX.notes) errors.evidenceNotes = "Please keep it under 1000 characters.";

  if (Object.keys(errors).length > 0) return { errors };
  return {
    values: {
      listingId,
      claimantName,
      roleAtBusiness: roleAtBusiness || null,
      evidenceNotes: evidenceNotes || null,
    },
  };
}
