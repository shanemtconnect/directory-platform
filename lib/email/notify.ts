import { enqueueJob } from "@/lib/db/queries/jobs";
import type { EnquiryResult } from "@/lib/db/queries/enquiries";
import type { SubmissionResult } from "@/lib/db/queries/submissions";
import type { RemovalDecision, RemovalRequestResult, ReportResult } from "@/lib/db/queries/trust";
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

/** The kinds worker/jobs/notify.ts claims. */
export const NOTIFY_KINDS: string[] = [
  NOTIFY_ENQUIRY,
  NOTIFY_SUBMISSION,
  NOTIFY_REPORT,
  NOTIFY_REMOVAL,
  NOTIFY_REMOVAL_ACTIONED,
  NOTIFY_REMOVAL_REJECTED,
  NOTIFY_DECISION,
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
 * A removal request notifies two people: the admin who has five working days
 * to act, and the requester, who otherwise has no way of knowing the form
 * worked. Silence after a privacy request is what turns it into a complaint.
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
