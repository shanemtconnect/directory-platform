import { siteConfig } from "@/config/site.config";
import { siteUrl } from "@/lib/schema/builders";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  type QueuedJob,
} from "@/lib/db/queries/jobs";
import {
  dueRenewalReminders,
  markReminderSent,
  reminderContext,
} from "@/lib/db/queries/billing";
import { BILLING_NOTIFY_KINDS, NOTIFY_BILLING_REMINDER } from "@/lib/email/notify";
import { renewalReminder, REMINDER_OFFSETS } from "@/lib/email/templates/billing";
import { sendEmail } from "@/lib/email/sender";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * Renewal reminders, in two halves.
 *
 * `enqueueDueReminders` decides WHO is owed one and writes that decision down
 * (a queue row and an audit marker, in one transaction). `drainBillingNotifications`
 * is the only half that touches a mail provider.
 *
 * They are separate because the decision must be exactly once and the send is
 * allowed to be retried. Doing both in one pass would mean a provider timeout
 * either re-deciding on the next tick — a second email — or losing the
 * reminder entirely.
 *
 * The dedupe key is (subscription, offset, period end), held on `audit_log`
 * rather than in a new table: nothing here needs a migration, the audit row is
 * the record we want anyway, and keying on the PERIOD END means next year's
 * 30-day reminder for the same subscription is a different key and still goes.
 */

const BATCH = 25;

class Retryable extends Error {}

/** Returns how many reminders were newly queued. */
export async function enqueueDueReminders(db: Db): Promise<number> {
  let queued = 0;

  for (const offsetDays of REMINDER_OFFSETS) {
    const targets = await dueRenewalReminders(db, ADMIN_VIEWER, { offsetDays });
    for (const target of targets) {
      // The queue row and the marker together: a marker without a job is a
      // reminder nobody gets, and a job without a marker is one they get twice.
      await db.transaction(async (sp) => {
        const tx = sp as unknown as Db;
        await enqueueJob(tx, ADMIN_VIEWER, {
          kind: NOTIFY_BILLING_REMINDER,
          payload: {
            subscriptionId: target.subscriptionId,
            offsetDays: target.offsetDays,
            periodEnd: target.currentPeriodEnd.toISOString(),
          },
        });
        await markReminderSent(tx, ADMIN_VIEWER, target);
      });
      queued++;
    }
  }

  return queued;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" ? value : null;
}

async function runReminder(db: Db, job: QueuedJob): Promise<void> {
  const subscriptionId = readString(job.payload, "subscriptionId");
  const offsetDays = readNumber(job.payload, "offsetDays");
  if (subscriptionId === null || offsetDays === null) {
    throw new Retryable("the job payload names no subscription");
  }

  // Re-read, never trust the payload: a subscription cancelled between the
  // tick that queued this and the tick that sends it must not be told to
  // expect a payment.
  const context = await reminderContext(db, ADMIN_VIEWER, subscriptionId);
  if (context === null) {
    console.warn(`[worker] renewal reminder for a subscription that has gone: ${subscriptionId}`);
    return;
  }
  if (context.cancelAtPeriodEnd || context.status !== "active") {
    console.log(`[worker] skipping renewal reminder for ${subscriptionId} (${context.status})`);
    return;
  }
  if (context.currentPeriodEnd === null) return;

  const to = context.email?.trim() ?? "";
  if (to === "") {
    // Nothing to retry: there is no address, and there will not be one on the
    // next attempt either.
    console.warn(`[worker] no contact address for subscription ${subscriptionId}`);
    return;
  }

  const message = renewalReminder({
    listingName: context.listingName,
    listingUrl: siteUrl(context.listingPath),
    billingUrl: siteUrl("/account/billing"),
    tierLabel: siteConfig.tiers[context.tier].label,
    interval: context.interval,
    renewsOn: context.currentPeriodEnd,
    offsetDays,
  });

  const result = await sendEmail({ to, ...message });
  if (!result.sent && result.reason === "rejected") {
    throw new Retryable(result.error ?? "the mail provider rejected the message");
  }
}

/** Returns how many jobs completed, for the worker's log line. */
export async function drainBillingNotifications(db: Db): Promise<number> {
  let done = 0;

  for (let n = 0; n < BATCH; n++) {
    const job = await claimNextJob(db, ADMIN_VIEWER, BILLING_NOTIFY_KINDS);
    if (!job) break;

    try {
      // A savepoint per job, for the same reason notify.ts uses one: the
      // advisory lock opened a single transaction, and a Postgres error inside
      // one handler would otherwise roll back every job already completed in
      // this batch — after their emails had gone out.
      await db.transaction(async (sp) => {
        await runReminder(sp as unknown as Db, job);
      });
      await completeJob(db, ADMIN_VIEWER, job.id);
      done++;
    } catch (e) {
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

/** One tick: decide, then send. */
export async function runRenewalReminders(db: Db): Promise<void> {
  const queued = await enqueueDueReminders(db);
  const sent = await drainBillingNotifications(db);
  if (queued > 0 || sent > 0) {
    console.log(`[worker] renewal reminders: ${queued} queued, ${sent} sent`);
  }
}
