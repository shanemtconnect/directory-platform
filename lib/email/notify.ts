import { enqueueJob } from "@/lib/db/queries/jobs";
import type { EnquiryResult } from "@/lib/db/queries/enquiries";
import type { SubmissionResult } from "@/lib/db/queries/submissions";
import type { RemovalDecision, RemovalRequestResult, ReportResult } from "@/lib/db/queries/trust";
import type {
  CreateReviewResult, ResendReviewResult, VerifyReviewResult,
} from "@/lib/db/queries/reviews";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";

/**
 * The two lines the server actions add.
 *
 * Both take the result the write returned and decide for themselves whether
 * there is anything to notify about, so an action never grows a branch it
 * would have to keep in step with this file. Both enqueue rather than send:
 * they are called inside the transaction that wrote the row, so the job is
 * committed with the enquiry or not at all — no notification for a write that
 * rolled back, and no lost notification for one that did not.
 *
 * Nothing here talks to a mail provider. A slow or dead Resend must never
 * appear as a slow or dead form.
 */

export const NOTIFY_ENQUIRY = "notify.enquiry";
export const NOTIFY_SUBMISSION = "notify.submission";
export const NOTIFY_REPORT = "notify.report";
export const NOTIFY_REMOVAL = "notify.removal";
export const NOTIFY_REMOVAL_ACTIONED = "notify.removal-actioned";
export const NOTIFY_REMOVAL_REJECTED = "notify.removal-rejected";

export const NOTIFY_DECISION = "notify.decision";

/** The magic link that is the whole of the proof on the automatic claim rung. */
export const NOTIFY_CLAIM_LINK = "notify.claimLink";
/** A document claim nobody can decide automatically. */
export const NOTIFY_CLAIM_SUBMITTED = "notify.claimSubmitted";
/** The outcome, approved or rejected, going back to the claimant. */
export const NOTIFY_CLAIM_DECIDED = "notify.claimDecided";

/** Reviews — the handlers sit at the foot of worker/jobs/notify.ts. */
export const NOTIFY_REVIEW_SUBMITTED = "notify.review.submitted";
export const NOTIFY_REVIEW_VERIFIED = "notify.review.verified";

/**
 * The two auth token emails. Queued like everything else rather than sent
 * inline from Better Auth's callback, for the same reason the enquiry form
 * does not send its own mail: a slow Resend must never be a slow sign-up, and
 * a failed send must be retried rather than lost inside a request that has
 * already returned.
 */
export const NOTIFY_AUTH_RESET = "notify.auth-reset";
export const NOTIFY_AUTH_VERIFY = "notify.auth-verify";

/**
 * One broadcast quote request: every recipient's copy and the requester's
 * acknowledgement, as one job. The handler sits at the foot of
 * worker/jobs/notify.ts (quotes module, Task 47).
 */
export const NOTIFY_QUOTE = "notify.quote";

/**
 * Every kind worker/jobs/notify.ts claims — the ONE answer to "what does the
 * notify worker drain". `BILLING_NOTIFY_KINDS` below is deliberately not in
 * it: renewal-reminders.ts drains those itself.
 *
 * A kind added here without a `case` in that file's `run` is caught by
 * worker/jobs/notify-kinds.test.ts, not discovered in production as a job
 * that retries five times and parks.
 */
export const NOTIFY_KINDS: string[] = [
  NOTIFY_ENQUIRY,
  NOTIFY_SUBMISSION,
  NOTIFY_REPORT,
  NOTIFY_REMOVAL,
  NOTIFY_REMOVAL_ACTIONED,
  NOTIFY_REMOVAL_REJECTED,
  NOTIFY_DECISION,
  NOTIFY_CLAIM_LINK,
  NOTIFY_CLAIM_SUBMITTED,
  NOTIFY_CLAIM_DECIDED,
  NOTIFY_REVIEW_SUBMITTED,
  NOTIFY_REVIEW_VERIFIED,
  NOTIFY_AUTH_RESET,
  NOTIFY_AUTH_VERIFY,
  NOTIFY_QUOTE,
];

/**
 * Job payloads are ids, never copies of the record. The worker re-reads the
 * row when it runs, so a payload cannot go stale and personal data is not
 * duplicated into a queue that outlives the thing it describes.
 */
export type EnquiryJobPayload = { enquiryId: string };

export type SubmissionJobPayload =
  /** The submission became a pending listing. */
  | { listingId: string }
  /** The town was not one we hold, so the payload was parked instead. */
  | { parkedId: string };

/**
 * The admin's decision, not the row's current status.
 *
 * Every other payload here is an id alone, because the worker re-reads the row
 * and a copied field could go stale. The decision is the exception on purpose:
 * it names the EVENT the submitter is being told about. A listing approved this
 * morning and taken down this afternoon still owes its submitter the approval
 * email, and a worker reading `listings.status` at send time would write the
 * wrong one.
 */
export type DecisionJobPayload = {
  listingId: string;
  decision: "approved" | "rejected";
};

export async function notifyEnquiry(
  tx: TestDb,
  viewer: Viewer,
  result: EnquiryResult,
): Promise<void> {
  if (result.outcome !== "created") return;
  const payload: EnquiryJobPayload = { enquiryId: result.enquiryId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_ENQUIRY, payload });
}

export async function notifySubmission(
  tx: TestDb,
  viewer: Viewer,
  result: SubmissionResult,
): Promise<void> {
  // A rejected category wrote nothing, so there is nothing to tell anyone.
  if (result.outcome === "unknown-category") return;
  const payload: SubmissionJobPayload =
    result.outcome === "created" ? { listingId: result.listingId } : { parkedId: result.parkedId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_SUBMISSION, payload });
}

export type ReportJobPayload = { reportId: string };
export type RemovalJobPayload = { removalRequestId: string };

export async function notifyReport(
  tx: TestDb,
  viewer: Viewer,
  result: ReportResult,
): Promise<void> {
  if (result.outcome !== "created") return;
  const payload: ReportJobPayload = { reportId: result.reportId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_REPORT, payload });
}

/**
 * A removal request notifies two people: the admin who has
 * `REMOVAL_SLA_WORKING_DAYS` working days to act, and the requester, who
 * otherwise has no way of knowing the form worked. Silence after a privacy request is what turns it into a complaint.
 */
export async function notifyRemoval(
  tx: TestDb,
  viewer: Viewer,
  result: RemovalRequestResult,
): Promise<void> {
  if (result.outcome !== "created") return;
  const payload: RemovalJobPayload = { removalRequestId: result.removalRequestId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_REMOVAL, payload });
}

export type RemovalDecisionJobPayload = { removalRequestId: string };

/**
 * The reply every removal page promises: "we email you when it is done."
 * Called from inside `actionRemovalRequest` itself, in the same transaction
 * as the decision, rather than left to whatever calls it — Task 16's admin
 * pages do not exist yet, and a promise this specific must not depend on
 * every future caller remembering to keep it. Sent either way: a rejection is
 * still an answer the requester was owed, not silence.
 */
export async function notifyRemovalDecision(
  tx: TestDb,
  viewer: Viewer,
  removalRequestId: string,
  decision: RemovalDecision,
): Promise<void> {
  const kind = decision === "actioned" ? NOTIFY_REMOVAL_ACTIONED : NOTIFY_REMOVAL_REJECTED;
  const payload: RemovalDecisionJobPayload = { removalRequestId };
  await enqueueJob(tx, viewer, { kind, payload });
}

/**
 * Queued by the admin approve/reject actions, inside the transaction that
 * changed the status. The submitter hears the outcome or the status change did
 * not happen — there is no third state where a listing goes live silently.
 */
export async function notifyDecision(
  tx: TestDb,
  viewer: Viewer,
  payload: DecisionJobPayload,
): Promise<void> {
  await enqueueJob(tx, viewer, { kind: NOTIFY_DECISION, payload });
}

/* ------------------------------------------------------ reviews (Task 22) */

/* The review kinds are declared with the rest of NOTIFY_KINDS above. */

/** Ids, never copies: the worker re-reads the review when it runs. */
export type ReviewJobPayload = { reviewId: string };

/**
 * The verification job also carries the token, because it has to:
 * `review_invites.token` holds only the digest (lib/security/token-hash.ts),
 * so there is nowhere the worker could re-read the link from. It rides in the
 * payload only while the job is pending and `completeJob` scrubs it once the
 * email has gone (lib/db/queries/jobs.ts). The worker still re-reads the
 * review, so a link that has been used or replaced by a resend is never sent.
 */
export type ReviewLinkJobPayload = { reviewId: string; token: string };

/**
 * The verification email. Enqueued inside the transaction that wrote the
 * review, so a review row without a link to confirm it cannot exist.
 */
export async function notifyReviewSubmitted(
  tx: TestDb,
  viewer: Viewer,
  result: CreateReviewResult,
): Promise<void> {
  if (result.outcome !== "created") return;
  const payload: ReviewLinkJobPayload = { reviewId: result.reviewId, token: result.token };
  await enqueueJob(tx, viewer, { kind: NOTIFY_REVIEW_SUBMITTED, payload });
}

/**
 * What happened after the click — published, or held for a moderator. Not sent
 * on a repeat click: the owner should hear about a review once.
 */
export async function notifyReviewVerified(
  tx: TestDb,
  viewer: Viewer,
  result: VerifyReviewResult,
): Promise<void> {
  if (result.outcome !== "verified" || result.repeat) return;
  const payload: ReviewJobPayload = { reviewId: result.reviewId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_REVIEW_VERIFIED, payload });
}

/**
 * A replacement verification link. Same job kind as the first one — the worker
 * checks the payload's token against whatever is live on the invite now, so
 * the earlier job, if still queued, finds its link superseded and sends
 * nothing — and there is no second template and no second handler to keep in
 * step.
 */
export async function notifyReviewResent(
  tx: TestDb,
  viewer: Viewer,
  result: ResendReviewResult,
): Promise<void> {
  if (result.outcome !== "sent") return;
  const payload: ReviewLinkJobPayload = { reviewId: result.reviewId, token: result.token };
  await enqueueJob(tx, viewer, { kind: NOTIFY_REVIEW_SUBMITTED, payload });
}

/** The submitted and decided payloads are the claim id and nothing else. */
export type ClaimJobPayload = { claimId: string };

/**
 * The link job is the one payload that carries a credential, because it has
 * to: `claims.magic_token` holds only the digest (lib/security/token-hash.ts),
 * so the raw token exists nowhere the worker could re-read it from. It rides
 * in the payload for exactly as long as the job is pending — the queue is
 * admin-only and the token lives thirty minutes — and `completeJob` scrubs
 * it the moment the email has gone (lib/db/queries/jobs.ts). The worker still
 * re-reads the claim, so a link that has expired, been decided, or been
 * replaced by a resend is never the one that goes out.
 */
export type ClaimLinkJobPayload = { claimId: string; token: string };

export async function notifyClaimLink(
  tx: TestDb,
  viewer: Viewer,
  claimId: string,
  token: string,
): Promise<void> {
  const payload: ClaimLinkJobPayload = { claimId, token };
  await enqueueJob(tx, viewer, { kind: NOTIFY_CLAIM_LINK, payload });
}

export async function notifyClaimSubmitted(
  tx: TestDb,
  viewer: Viewer,
  claimId: string,
): Promise<void> {
  const payload: ClaimJobPayload = { claimId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_CLAIM_SUBMITTED, payload });
}

export async function notifyClaimDecided(
  tx: TestDb,
  viewer: Viewer,
  claimId: string,
): Promise<void> {
  const payload: ClaimJobPayload = { claimId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_CLAIM_DECIDED, payload });
}

/* ------------------------------------------------------------------ billing */

/**
 * Renewal reminders go through the same queue for the same reason enquiries
 * do: the hourly job that finds them must not be the thing that talks to a
 * mail provider, or one slow send holds up every other reminder in the batch
 * and a crash loses the ones already decided on.
 *
 * A SEPARATE kind list, not an addition to NOTIFY_KINDS. `claimNextJob` takes
 * the kinds its caller handles precisely so a second consumer cannot be handed
 * work meant for the first — the billing worker drains these, the notify
 * worker drains those, and neither can starve the other.
 */
export const NOTIFY_BILLING_REMINDER = "notify.billing_reminder";

export const BILLING_NOTIFY_KINDS: string[] = [NOTIFY_BILLING_REMINDER];

export type BillingReminderJobPayload = {
  subscriptionId: string;
  /** 30, 7 or 0. Carried so the email can read differently on the day. */
  offsetDays: number;
  /** The period end this reminder is about; the dedupe key includes it. */
  periodEnd: string;
};

export async function notifyRenewal(
  tx: TestDb,
  viewer: Viewer,
  payload: BillingReminderJobPayload,
): Promise<void> {
  await enqueueJob(tx, viewer, { kind: NOTIFY_BILLING_REMINDER, payload: { ...payload } });
}

/*
 * ---------------------------------------------------------------------------
 * Auth emails (password reset, address verification). The kinds themselves
 * are declared with the rest of NOTIFY_KINDS above.
 * ---------------------------------------------------------------------------
 */

/**
 * How long a reset or verification token lives, in seconds.
 *
 * One constant, because two things have to agree about it: lib/auth/server.ts
 * configures Better Auth with it, and the worker states it in the email body.
 * A body that promises an hour for a token that lasted fifteen minutes is a
 * support ticket, so the number is not written twice.
 *
 * An hour is Better Auth's own default and the right order of magnitude: long
 * enough to survive a mail queue and a person who reads their email after
 * lunch, short enough that a link sitting in an exported mailbox is not a
 * standing key to the account.
 */
export const AUTH_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * A user id and a token — never the address, never the name, and never a URL.
 *
 * The token has to be in the payload: it is single-use and exists only for
 * the length of this one callback, so there is nothing to re-derive it from
 * later. The link is built by the worker from the token and our own origin
 * (lib/auth/links.ts), so a queue row never carries an href that something
 * writing to the queue could point elsewhere. Everything else follows the
 * rule the other payloads follow and is re-read at send time
 * (lib/db/queries/profile.ts), which keeps a personal address out of a queue
 * table that outlives the email and means an account deleted between enqueue
 * and send is simply never written to.
 *
 * The token is scrubbed from the row when the job completes
 * (lib/db/queries/jobs.ts). Until then it is the reason these jobs matter
 * operationally: they are short-lived by design (an hour), so a queue that
 * has stalled for longer than that is sending links that are already dead.
 */
export type AuthEmailJobPayload = { userId: string; token: string };

export async function notifyAuthEmail(
  tx: TestDb,
  viewer: Viewer,
  kind: typeof NOTIFY_AUTH_RESET | typeof NOTIFY_AUTH_VERIFY,
  payload: AuthEmailJobPayload,
): Promise<void> {
  await enqueueJob(tx, viewer, { kind, payload });
}

/* ------------------------------------------------------- quotes (Task 47) */

import type { QuoteRequestResult } from "@/lib/db/queries/quotes";

/** An id alone: the worker re-reads the request and re-resolves every address. */
export type QuoteJobPayload = { quoteRequestId: string };

export async function notifyQuoteRequest(
  tx: TestDb,
  viewer: Viewer,
  result: QuoteRequestResult,
): Promise<void> {
  if (result.outcome !== "created") return;
  const payload: QuoteJobPayload = { quoteRequestId: result.quoteRequestId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_QUOTE, payload });
}
