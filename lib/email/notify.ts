import { enqueueJob } from "@/lib/db/queries/jobs";
import type { EnquiryResult } from "@/lib/db/queries/enquiries";
import type { SubmissionResult } from "@/lib/db/queries/submissions";
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

/** The magic link that is the whole of the proof on the automatic claim rung. */
export const NOTIFY_CLAIM_LINK = "notify.claimLink";
/** A document claim nobody can decide automatically. */
export const NOTIFY_CLAIM_SUBMITTED = "notify.claimSubmitted";
/** The outcome, approved or rejected, going back to the claimant. */
export const NOTIFY_CLAIM_DECIDED = "notify.claimDecided";

/** The kinds worker/jobs/notify.ts claims. */
export const NOTIFY_KINDS: string[] = [
  NOTIFY_ENQUIRY,
  NOTIFY_SUBMISSION,
  NOTIFY_CLAIM_LINK,
  NOTIFY_CLAIM_SUBMITTED,
  NOTIFY_CLAIM_DECIDED,
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

/**
 * The claim payload is the claim id and nothing else — not the token.
 *
 * A magic token in a queue row is a live credential sitting in a table that
 * outlives the thing it unlocks, readable by anything that can read the queue.
 * The worker re-reads the claim when it runs, so an expired or superseded
 * token is never sent.
 */
export type ClaimJobPayload = { claimId: string };

export async function notifyClaimLink(
  tx: TestDb,
  viewer: Viewer,
  claimId: string,
): Promise<void> {
  const payload: ClaimJobPayload = { claimId };
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
