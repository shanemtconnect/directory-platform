import { enqueueJob } from "@/lib/db/queries/jobs";
import type { EnquiryResult } from "@/lib/db/queries/enquiries";
import type { SubmissionResult } from "@/lib/db/queries/submissions";
import type {
  CreateReviewResult, ResendReviewResult, VerifyReviewResult,
} from "@/lib/db/queries/reviews";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

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

/** The kinds worker/jobs/notify.ts claims. */
export const NOTIFY_KINDS: string[] = [NOTIFY_ENQUIRY, NOTIFY_SUBMISSION];

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

/* ------------------------------------------------------ reviews (Task 22) */

/**
 * Appended rather than woven in: this file is shared by several modules
 * landing in parallel, so each one adds its kinds at the end and pushes them
 * onto `NOTIFY_KINDS` instead of editing the literal above — a line every
 * module would otherwise be rewriting at once.
 */
export const NOTIFY_REVIEW_SUBMITTED = "notify.review.submitted";
export const NOTIFY_REVIEW_VERIFIED = "notify.review.verified";

NOTIFY_KINDS.push(NOTIFY_REVIEW_SUBMITTED, NOTIFY_REVIEW_VERIFIED);

/** Ids, never copies: the worker re-reads the review when it runs. */
export type ReviewJobPayload = { reviewId: string };

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
  const payload: ReviewJobPayload = { reviewId: result.reviewId };
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
 * re-reads the review and picks up whatever token is live on the invite now —
 * so there is no second template and no second handler to keep in step.
 */
export async function notifyReviewResent(
  tx: TestDb,
  viewer: Viewer,
  result: ResendReviewResult,
): Promise<void> {
  if (result.outcome !== "sent") return;
  const payload: ReviewJobPayload = { reviewId: result.reviewId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_REVIEW_SUBMITTED, payload });
}
