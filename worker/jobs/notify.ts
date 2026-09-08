import { siteUrl } from "@/lib/schema/builders";
import { claimNextJob, completeJob, failJob, type QueuedJob } from "@/lib/db/queries/jobs";
import {
  enquiryNotification,
  parkedSubmissionNotification,
  submissionNotification,
  type SubmissionNotification,
} from "@/lib/db/queries/notifications";
import { ADMIN_VIEWER } from "@/lib/db/viewer";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/sender";
import { enquiryToAdmin, enquiryToOwner } from "@/lib/email/templates/enquiry";
import { submissionReceived, submissionToAdmin } from "@/lib/email/templates/submission";
import { NOTIFY_ENQUIRY, NOTIFY_KINDS, NOTIFY_SUBMISSION } from "@/lib/email/notify";
import type { Db } from "@/lib/db/client";

/**
 * Drains the notification queue.
 *
 * Runs inside the transaction `withAdvisoryLock` opens, so the row locks
 * `claimNextJob` takes last exactly as long as the tick does and a crash
 * mid-batch releases every job it had claimed.
 */

/**
 * One tick's worth. The cap exists because the claim holds a row lock for the
 * whole transaction: a queue that has backed up should take several ticks
 * rather than one very long one.
 */
const BATCH = 25;

/** Thrown to mark a job for retry. The message becomes `last_error`. */
class Retryable extends Error {}

let warnedNoAdmin = false;

function adminAddress(): string {
  const address = process.env.ADMIN_NOTIFICATION_EMAIL?.trim() ?? "";
  if (address === "" && !warnedNoAdmin) {
    // Otherwise every admin notification is dropped by sendEmail's
    // no-recipient path and the queue looks perfectly healthy.
    warnedNoAdmin = true;
    console.warn("[worker] ADMIN_NOTIFICATION_EMAIL is unset — no admin notifications");
  }
  return address;
}

/**
 * Payloads come back out of a jsonb column, so they are read rather than cast.
 * A shape the handler cannot use is a bug worth seeing in `last_error`, not a
 * TypeError that takes the whole tick down.
 */
function readId(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A send that never reached the provider — no key, no address — is not a
 * failure of this job. Retrying it would park every notification a site
 * accumulates before its mail is configured, and lose them.
 */
async function deliver(message: EmailMessage): Promise<SendResult> {
  const result = await sendEmail(message);
  if (!result.sent && result.reason === "rejected") {
    throw new Retryable(result.error ?? "the mail provider rejected the message");
  }
  return result;
}

async function runEnquiry(db: Db, payload: Record<string, unknown>): Promise<void> {
  const enquiryId = readId(payload, "enquiryId");
  if (enquiryId === null) throw new Retryable("The job carries no enquiryId");

  const data = await enquiryNotification(db, ADMIN_VIEWER, enquiryId);
  if (!data) throw new Retryable(`No notifiable enquiry ${enquiryId}`);

  const content = {
    listingName: data.listing.name,
    listingUrl: siteUrl(data.listing.path),
    from: data.enquiry,
    message: data.enquiry.message,
  };

  // An unclaimed listing's contact address is one we hold, not one anybody
  // asked us to write to. Enquiries reach a business once it has claimed the
  // listing and not before.
  if (data.listing.claimed && data.listing.email !== null && data.listing.email.trim() !== "") {
    await deliver({ to: data.listing.email, ...enquiryToOwner(content) });
  }

  // Always. Until a listing is claimed we are the only one who will answer,
  // and the admin copy is the record that the lead existed at all.
  await deliver({ to: adminAddress(), ...enquiryToAdmin(content) });
}

async function runSubmission(db: Db, payload: Record<string, unknown>): Promise<void> {
  const listingId = readId(payload, "listingId");
  const parkedId = readId(payload, "parkedId");

  let data: SubmissionNotification | null = null;
  if (listingId !== null) {
    data = await submissionNotification(db, ADMIN_VIEWER, listingId);
  } else if (parkedId !== null) {
    data = await parkedSubmissionNotification(db, ADMIN_VIEWER, parkedId);
  } else {
    throw new Retryable("The job names neither a listing nor a parked submission");
  }
  if (!data) throw new Retryable("The submission this job names is not there");

  const content = { ...data, reviewUrl: siteUrl("/admin") };

  await deliver({ to: adminAddress(), ...submissionToAdmin(content) });
  // Second, and separately: the submitter's receipt is worth nothing if a
  // failure to reach the admin swallowed it.
  await deliver({ to: content.submitter.email, ...submissionReceived(content) });
}

async function run(db: Db, job: QueuedJob): Promise<void> {
  switch (job.kind) {
    case NOTIFY_ENQUIRY:
      return runEnquiry(db, job.payload);
    case NOTIFY_SUBMISSION:
      return runSubmission(db, job.payload);
    default:
      // claimNextJob is given NOTIFY_KINDS, so this is unreachable unless a
      // kind is added to that list without a case here.
      throw new Retryable(`No handler for job kind ${job.kind}`);
  }
}

/** Returns how many jobs completed, for the worker's log line. */
export async function processNotifications(db: Db): Promise<number> {
  let done = 0;

  for (let n = 0; n < BATCH; n++) {
    const job = await claimNextJob(db, ADMIN_VIEWER, NOTIFY_KINDS);
    if (!job) break;

    try {
      await run(db, job);
      await completeJob(db, ADMIN_VIEWER, job.id);
      done++;
    } catch (e) {
      // Caught rather than thrown on: the failure has to be RECORDED, and a
      // throw here would roll back the transaction the record lives in.
      const message = e instanceof Error ? e.message : String(e);
      const outcome = await failJob(db, ADMIN_VIEWER, job.id, message);
      console.error(
        `[worker] ${job.kind} ${job.id} ${outcome.status === "failed" ? "PARKED" : "failed"}` +
          ` after ${outcome.attempts}: ${message}`,
      );
    }
  }

  return done;
}
