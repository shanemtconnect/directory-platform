import { siteUrl } from "@/lib/schema/builders";
import {
  claimNextJob,
  completeJob,
  failJob,
  markDelivered,
  type QueuedJob,
} from "@/lib/db/queries/jobs";
import {
  enquiryNotification,
  parkedSubmissionNotification,
  submissionNotification,
  type SubmissionNotification,
} from "@/lib/db/queries/notifications";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { sendEmail, type EmailMessage } from "@/lib/email/sender";
import { enquiryToAdmin, enquiryToOwner } from "@/lib/email/templates/enquiry";
import { submissionReceived, submissionToAdmin } from "@/lib/email/templates/submission";
import { removalNotification, reportNotification } from "@/lib/db/queries/trust";
import { removalReceived, removalToAdmin, reportToAdmin } from "@/lib/email/templates/trust";
import {
  NOTIFY_ENQUIRY,
  NOTIFY_KINDS,
  NOTIFY_REMOVAL,
  NOTIFY_REPORT,
  NOTIFY_SUBMISSION,
} from "@/lib/email/notify";
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
 * A job's recipients, tracked one at a time.
 *
 * A notification goes to two or three people and the retry is per JOB, so
 * without this a single bad address — a mistyped ADMIN_NOTIFICATION_EMAIL is
 * the obvious one — sends the owner of a claimed listing the same enquiry once
 * per attempt, six times over. `done` is what earlier attempts reached; `fresh`
 * is what this one did, and is written back whether the job as a whole
 * succeeds or fails.
 *
 * The keys are roles rather than addresses: they have to be the same string on
 * every attempt, and an address read from a row that has since been edited
 * would not be.
 */
interface Delivery {
  done: Set<string>;
  fresh: string[];
}

const OWNER = "owner";
const ADMIN = "admin";
const SUBMITTER = "submitter";
const REQUESTER = "requester";

/**
 * A send that never reached the provider — no key, no address — is not a
 * failure of this job. Retrying it would park every notification a site
 * accumulates before its mail is configured, and lose them.
 */
async function deliver(d: Delivery, key: string, message: EmailMessage): Promise<void> {
  // Already sent on an earlier attempt: the retry is for the ones that failed.
  if (d.done.has(key)) return;

  const result = await sendEmail(message);
  if (!result.sent && result.reason === "rejected") {
    throw new Retryable(result.error ?? "the mail provider rejected the message");
  }
  // Anything that is not a rejection is as done as this recipient will get:
  // the job will not be retried on its account.
  d.fresh.push(key);
}

async function runEnquiry(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
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
    await deliver(d, OWNER, { to: data.listing.email, ...enquiryToOwner(content) });
  }

  // Always. Until a listing is claimed we are the only one who will answer,
  // and the admin copy is the record that the lead existed at all.
  await deliver(d, ADMIN, { to: adminAddress(), ...enquiryToAdmin(content) });
}

async function runSubmission(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
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

  // The person who is waiting for it goes first. The admin copy is a record we
  // keep for ourselves, and a wrong address on it must not hold up the receipt
  // the submitter is owed.
  await deliver(d, SUBMITTER, { to: content.submitter.email, ...submissionReceived(content) });
  await deliver(d, ADMIN, { to: adminAddress(), ...submissionToAdmin(content) });
}

async function runReport(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
  const reportId = readId(payload, "reportId");
  if (reportId === null) throw new Retryable("The job carries no reportId");

  const data = await reportNotification(db, ADMIN_VIEWER, reportId);
  if (!data) throw new Retryable(`No notifiable report ${reportId}`);

  // Us only. A report is a correction queue, not something to forward to the
  // business it is about — the reporter did not write to them.
  await deliver(d, ADMIN, {
    to: adminAddress(),
    ...reportToAdmin({
      listingName: data.listingName,
      listingUrl: siteUrl(data.listingPath),
      reason: data.reason,
      detail: data.detail,
      reporterEmail: data.reporterEmail,
      reviewUrl: siteUrl("/admin"),
    }),
  });
}

async function runRemoval(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
  const removalRequestId = readId(payload, "removalRequestId");
  if (removalRequestId === null) throw new Retryable("The job carries no removalRequestId");

  const data = await removalNotification(db, ADMIN_VIEWER, removalRequestId);
  if (!data) throw new Retryable(`No notifiable removal request ${removalRequestId}`);

  const content = {
    listingName: data.listingName,
    listingUrl: siteUrl(data.listingPath),
    requester: { name: data.requesterName, email: data.requesterEmail },
    relationship: data.relationship,
    reason: data.reason,
    dueAt: data.dueAt,
    reviewUrl: siteUrl("/admin"),
  };

  // The person waiting for an answer goes first, as on a submission: a wrong
  // address on our own copy must not hold up the acknowledgement they are owed.
  await deliver(d, REQUESTER, { to: data.requesterEmail, ...removalReceived(content) });
  await deliver(d, ADMIN, { to: adminAddress(), ...removalToAdmin(content) });
}

async function run(db: Db, d: Delivery, job: QueuedJob): Promise<void> {
  switch (job.kind) {
    case NOTIFY_ENQUIRY:
      return runEnquiry(db, d, job.payload);
    case NOTIFY_SUBMISSION:
      return runSubmission(db, d, job.payload);
    case NOTIFY_REPORT:
      return runReport(db, d, job.payload);
    case NOTIFY_REMOVAL:
      return runRemoval(db, d, job.payload);
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

    const d: Delivery = { done: new Set(job.delivered), fresh: [] };

    try {
      // A savepoint per job, not one transaction per tick.
      //
      // The advisory lock opened a single transaction and every completeJob in
      // the batch lands in it. A Postgres-level error inside one handler — a
      // malformed id, a dropped connection — aborts that transaction, so every
      // job already completed is rolled back AFTER its email has gone out and
      // the next tick sends all of them again. Rolling back to a savepoint
      // undoes only the job that failed and leaves the transaction usable, so
      // the failure can still be recorded and the batch can carry on.
      await db.transaction(async (sp) => {
        await run(sp as unknown as Db, d, job);
      });
      await completeJob(db, ADMIN_VIEWER, job.id);
      done++;
    } catch (e) {
      // Caught rather than thrown on: the failure has to be RECORDED, and a
      // throw here would roll back the transaction the record lives in.
      const message = e instanceof Error ? e.message : String(e);
      // Before the failure, so the retry it schedules knows what already went
      // out. Otherwise the surviving recipients get a copy per attempt.
      if (d.fresh.length > 0) {
        await markDelivered(db, ADMIN_VIEWER, job.id, [...d.done, ...d.fresh]);
      }
      const outcome = await failJob(db, ADMIN_VIEWER, job.id, message);
      console.error(
        `[worker] ${job.kind} ${job.id} ${outcome.status === "failed" ? "PARKED" : "failed"}` +
          ` after ${outcome.attempts}: ${message}`,
      );
    }
  }

  return done;
}
