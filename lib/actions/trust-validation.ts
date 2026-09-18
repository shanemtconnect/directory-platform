import { reportReason } from "@/lib/db/schema/enums";
import {
  REMOVAL_RELATIONSHIPS,
  type RemovalRelationship,
  type ReportReason,
} from "@/lib/db/queries/trust";
import { isUuid, normaliseBody, stripCrlf } from "./validation";

/**
 * Field validation for the two trust-and-safety forms.
 *
 * Separate from lib/actions/validation.ts only because that file is already
 * the enquiry and submission pair and these are a different queue; the rules
 * are the same rules and the primitives come from there. In particular:
 *
 *  - anything compared against a uuid column is shape-checked here, because
 *    Postgres answers a malformed uuid with an exception and the action
 *    becomes a 500 instead of a field error;
 *  - single-line fields lose CR and LF (`stripCrlf`), because a reporter's
 *    email address and a requester's name are both interpolated into a
 *    notification email;
 *  - the two free-text bodies keep their paragraph breaks (`normaliseBody`) —
 *    they are never read into a header, and collapsing them just destroys
 *    formatting somebody typed on purpose.
 *
 * Neither form may live in the "use server" module: those may only export
 * async functions, and validation that cannot be unit tested is validation
 * nobody checks.
 */

function field(form: FormData, key: string): string {
  return stripCrlf(String(form.get(key) ?? "")).trim();
}

function bodyField(form: FormData, key: string): string {
  return normaliseBody(String(form.get(key) ?? "")).trim();
}

type Result<T> =
  | { values: T; errors?: undefined }
  | { values?: undefined; errors: Record<string, string> };

/** As permissive as the enquiry form's, and for the same reason. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Long enough for the whole story, short enough to starve an essay-spammer. */
const DETAIL_MAX = 1000;
const EMAIL_MAX = 254;
const NAME_MAX = 120;

/* ------------------------------------------------------------------ reports */

export interface ReportValues {
  listingId: string;
  reason: ReportReason;
  detail: string | null;
  reporterEmail: string | null;
}

const REASONS: string[] = [...reportReason.enumValues];

function isReason(value: string): value is ReportReason {
  return REASONS.includes(value);
}

export function validateReport(form: FormData): Result<ReportValues> {
  const errors: Record<string, string> = {};
  const listingId = field(form, "listingId");
  const reason = field(form, "reason");
  const detail = bodyField(form, "detail");
  const reporterEmail = field(form, "reporterEmail");

  // A hidden field, so this is never a typo — it is a tampered form or a bot.
  if (!isUuid(listingId)) errors.listingId = "That listing could not be found.";
  if (!isReason(reason)) errors.reason = "Please choose what is wrong.";

  // Every other reason names the problem by itself. "Something else" does not,
  // and a report nobody can act on wastes the reporter's goodwill as well as
  // our time.
  if (reason === "other" && detail === "") {
    errors.detail = "Please tell us what is wrong.";
  }
  if (detail.length > DETAIL_MAX) {
    errors.detail = `Please keep it under ${DETAIL_MAX} characters.`;
  }

  // Optional on purpose: a correction is worth having from someone who does
  // not want to be written back to.
  if (reporterEmail !== "" && (!EMAIL.test(reporterEmail) || reporterEmail.length > EMAIL_MAX)) {
    errors.reporterEmail = "Please give a valid email address, or leave it blank.";
  }

  if (Object.keys(errors).length > 0) return { errors };
  return {
    values: {
      listingId,
      reason: reason as ReportReason,
      detail: detail || null,
      reporterEmail: reporterEmail || null,
    },
  };
}

/* --------------------------------------------------------- removal requests */

export interface RemovalRequestValues {
  listingId: string;
  requesterName: string;
  requesterEmail: string;
  relationship: RemovalRelationship;
  reason: string | null;
}

function isRelationship(value: string): value is RemovalRelationship {
  return (REMOVAL_RELATIONSHIPS as readonly string[]).includes(value);
}

export function validateRemovalRequest(form: FormData): Result<RemovalRequestValues> {
  const errors: Record<string, string> = {};
  const listingId = field(form, "listingId");
  const requesterName = field(form, "requesterName");
  const requesterEmail = field(form, "requesterEmail");
  const relationship = field(form, "relationship");
  const reason = bodyField(form, "reason");

  if (!isUuid(listingId)) errors.listingId = "That listing could not be found.";

  // Both required, unlike on the report form: a removal request gets an answer
  // within `REMOVAL_SLA_WORKING_DAYS` working days and there has to be
  // somewhere to send it.
  if (requesterName.length < 2) errors.requesterName = "Please give your name.";
  if (requesterName.length > NAME_MAX) errors.requesterName = "That name is too long.";
  if (!EMAIL.test(requesterEmail)) errors.requesterEmail = "Please give a valid email address.";
  if (requesterEmail.length > EMAIL_MAX) errors.requesterEmail = "That email address is too long.";

  if (!isRelationship(relationship)) errors.relationship = "Please choose an option.";

  // Not required: /data-sources says you do not have to give a reason, and a
  // form that then insists on one makes a liar of the page.
  if (reason.length > DETAIL_MAX) {
    errors.reason = `Please keep it under ${DETAIL_MAX} characters.`;
  }

  if (Object.keys(errors).length > 0) return { errors };
  return {
    values: {
      listingId,
      requesterName,
      requesterEmail,
      relationship: relationship as RemovalRelationship,
      reason: reason || null,
    },
  };
}
