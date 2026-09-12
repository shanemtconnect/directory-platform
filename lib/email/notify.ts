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
