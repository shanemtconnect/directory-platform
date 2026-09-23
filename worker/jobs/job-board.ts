import { now } from "@/lib/clock";
import { siteUrl } from "@/lib/schema/builders";
import {
  claimNextJob,
  completeJob,
  failJob,
  type QueuedJob,
} from "@/lib/db/queries/jobs";
import {
  expireDueJobs,
  jobNotifyContext,
  jobPaths,
  jobsDueReminder,
  markJobReminderSent,
} from "@/lib/db/queries/job-board";
import {
  JOB_BOARD_NOTIFY_KINDS,
  NOTIFY_JOB_DECIDED,
  NOTIFY_JOB_EXPIRING,
  NOTIFY_JOB_SUBMITTED,
  notifyJobExpiring,
} from "@/lib/email/notify-jobs";
import { jobApproved, jobExpiring, jobRejected, jobSubmittedToAdmin } from "@/lib/email/templates/jobs";
import { sendEmail } from "@/lib/email/sender";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * The jobs board's tick (Task 49): expire what is due, queue the reminders,
 * send what is queued.
 *
 * Same two-halves shape as renewal-reminders.ts and for the same reason: the
 * DECISION (this post is expiring, this poster is owed a reminder) is written
 * down exactly once, and only the SEND is retried. The reminder's once-ness is
 * `jobs.reminder_sent_at`, set in the same transaction as the queue row.
 *
 * A separate drain from worker/jobs/notify.ts, over its own kind list, so a
 * module the notify worker knows nothing about cannot be handed to it.
 */

const BATCH = 25;

class Retryable extends Error {}

let warnedNoAdmin = false;

function adminAddress(): string {
  const address = process.env.ADMIN_NOTIFICATION_EMAIL?.trim() ?? "";
  if (address === "" && !warnedNoAdmin) {
    warnedNoAdmin = true;
    console.warn("[worker] ADMIN_NOTIFICATION_EMAIL is unset — no job board admin notifications");
  }
  return address;
}

function readId(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Published jobs past their date. Returns the ISR paths left stale. */
export async function expireJobs(db: Db): Promise<{ expired: string[]; paths: string[] }> {
  const paths = new Set<string>();
  const expired = await db.transaction(async (sp) => {
    const tx = sp as unknown as Db;
    // Paths BEFORE the change would be the pillar-page rule; here the job page
    // survives expiry (it renders as closed) so before and after are the same
    // list, and reading after is one round trip fewer to get wrong.
    const ids = await expireDueJobs(tx, ADMIN_VIEWER);
    for (const id of ids) for (const p of await jobPaths(tx, ADMIN_VIEWER, id)) paths.add(p);
    return ids;
  });
  return { expired, paths: [...paths] };
}

/** Returns how many reminders were newly queued. */
export async function enqueueExpiryReminders(db: Db): Promise<number> {
  let queued = 0;
  const due = await jobsDueReminder(db, ADMIN_VIEWER);
  for (const target of due) {
    // The queue row and the marker together, or neither.
    await db.transaction(async (sp) => {
      const tx = sp as unknown as Db;
      await markJobReminderSent(tx, ADMIN_VIEWER, target.id);
      await notifyJobExpiring(tx, ADMIN_VIEWER, target.id);
    });
    queued++;
  }
  return queued;
}

async function send(to: string, message: { subject: string; html: string; text: string; replyTo?: string }): Promise<void> {
  const result = await sendEmail({ to, ...message });
  if (!result.sent && result.reason === "rejected") {
    throw new Retryable(result.error ?? "the mail provider rejected the message");
  }
}

async function run(db: Db, job: QueuedJob): Promise<void> {
  const jobId = readId(job.payload, "jobId");
  if (jobId === null) throw new Retryable("the job payload names no job post");

  // Re-read, never trust the payload: a post removed between the tick that
  // queued this and the one that sends it must not be announced as live.
  const context = await jobNotifyContext(db, ADMIN_VIEWER, jobId);
  if (context === null) {
    console.warn(`[worker] job board notification for a post that has gone: ${jobId}`);
    return;
  }
  const jobUrl = siteUrl(context.path);

  switch (job.kind) {
    case NOTIFY_JOB_SUBMITTED: {
      const to = adminAddress();
      if (to === "") return;
      await send(
        to,
        jobSubmittedToAdmin({
          title: context.title,
          companyName: context.companyName,
          cityName: context.cityName,
          posterName: context.posterName,
          posterEmail: context.posterEmail,
          paid: context.paymentStatus === "paid",
          reviewUrl: siteUrl("/admin/jobs"),
        }),
      );
      return;
    }
    case NOTIFY_JOB_DECIDED: {
      const to = context.posterEmail?.trim() ?? "";
      if (to === "") return;
      const data = {
        title: context.title,
        posterName: context.posterName,
        jobUrl,
        closesOn: context.expiresAt,
        reason: context.rejectedReason,
      };
      if (context.status === "published" || context.status === "expired") {
        await send(to, jobApproved(data));
      } else if (context.status === "removed") {
        await send(to, jobRejected(data));
      }
      // Still pending: nothing was decided after all (the row was reopened);
      // sending either email would be wrong, so neither goes.
      return;
    }
    case NOTIFY_JOB_EXPIRING: {
      const to = context.posterEmail?.trim() ?? "";
      if (to === "" || context.expiresAt === null) return;
      // Already closed, or taken down, by the time the queue got to it.
      if (context.status !== "published") return;
      await send(
        to,
        jobExpiring({
          title: context.title,
          posterName: context.posterName,
          jobUrl,
          closesOn: context.expiresAt,
          postUrl: siteUrl("/post-a-job"),
        }),
      );
      return;
    }
    default:
      throw new Retryable(`No handler for job kind ${job.kind}`);
  }
}

/** Returns how many jobs completed, for the worker's log line. */
export async function drainJobBoardNotifications(db: Db): Promise<number> {
  let done = 0;

  for (let n = 0; n < BATCH; n++) {
    const job = await claimNextJob(db, ADMIN_VIEWER, JOB_BOARD_NOTIFY_KINDS);
    if (!job) break;

    try {
      // A savepoint per job — see notify.ts for why.
      await db.transaction(async (sp) => {
        await run(sp as unknown as Db, job);
      });
      await completeJob(db, ADMIN_VIEWER, job.id);
      done++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const outcome = await failJob(db, ADMIN_VIEWER, job.id, message);
      console.error(
        `[worker] ${job.kind} ${job.id} ${outcome.status === "failed" ? "PARKED" : "failed"}` +
          ` after ${outcome.attempts}: ${message.slice(0, 200)}`,
      );
    }
  }

  return done;
}

/** One tick: expire, decide, send. Hands back the paths expiry left stale. */
export async function runJobBoard(db: Db): Promise<{ revalidate: string[] }> {
  const { expired, paths } = await expireJobs(db);
  const queued = await enqueueExpiryReminders(db);
  const sent = await drainJobBoardNotifications(db);
  if (expired.length > 0 || queued > 0 || sent > 0) {
    console.log(`[worker] job board: ${expired.length} expired, ${queued} reminders queued, ${sent} sent at ${now().toISOString()}`);
  }
  return { revalidate: paths };
}
