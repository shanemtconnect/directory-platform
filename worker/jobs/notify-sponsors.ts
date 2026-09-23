import { siteUrl } from "@/lib/schema/builders";
import { claimNextJob, completeJob, failJob, type QueuedJob } from "@/lib/db/queries/jobs";
import { sponsorNotification } from "@/lib/db/queries/ads";
import { NOTIFY_SPONSOR_DECIDED, NOTIFY_SPONSOR_SUBMITTED, SPONSOR_NOTIFY_KINDS } from "@/lib/email/notify";
import { sponsorApproved, sponsorRejected, sponsorToAdmin } from "@/lib/email/templates/sponsor";
import { sendEmail, type EmailMessage } from "@/lib/email/sender";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * Sponsor rail mail (Task 43), a sibling of the main notify drain so the
 * shared switch in worker/jobs/notify.ts is untouched. Submitted → admin;
 * decided → the advertiser, approved or rejected by the campaign's status.
 */
const BATCH = 25;

class Retryable extends Error {}

let warnedNoAdmin = false;
function adminAddress(): string {
  const address = process.env.ADMIN_NOTIFICATION_EMAIL?.trim() ?? "";
  if (address === "" && !warnedNoAdmin) {
    warnedNoAdmin = true;
    console.warn("[worker] ADMIN_NOTIFICATION_EMAIL is unset — no sponsor notifications to the admin");
  }
  return address;
}

async function deliver(message: EmailMessage): Promise<void> {
  const result = await sendEmail(message);
  if (!result.sent && result.reason === "rejected") {
    throw new Retryable(result.error ?? "the mail provider rejected the message");
  }
}

async function run(db: Db, job: QueuedJob): Promise<void> {
  const campaignId = job.payload.campaignId;
  if (typeof campaignId !== "string" || campaignId === "") {
    throw new Retryable("The job carries no campaignId");
  }
  const data = await sponsorNotification(db, ADMIN_VIEWER, campaignId);
  if (!data) throw new Retryable(`No sponsor campaign ${campaignId}`);
  const content = {
    name: data.name,
    title: data.title,
    blurb: data.blurb,
    targetUrl: data.targetUrl,
    advertiserEmail: data.advertiserEmail,
    reviewUrl: siteUrl("/admin/sponsors"),
    manageUrl: siteUrl("/advertise/sponsor"),
  };
  if (job.kind === NOTIFY_SPONSOR_SUBMITTED) {
    return deliver({ to: adminAddress(), ...sponsorToAdmin(content) });
  }
  if (job.kind === NOTIFY_SPONSOR_DECIDED) {
    const to = data.advertiserEmail?.trim() ?? "";
    if (to === "") {
      console.warn(`[worker] sponsor campaign ${campaignId} has nobody to tell`);
      return;
    }
    if (data.status === "active") return deliver({ to, ...sponsorApproved(content) });
    if (data.status === "rejected") {
      return deliver({ to, ...sponsorRejected({ ...content, reason: data.rejectionReason ?? "" }) });
    }
    // Paused, ended or back to pending: nothing to announce.
    return;
  }
  throw new Retryable(`No handler for job kind ${job.kind}`);
}

export async function processSponsorNotifications(db: Db): Promise<number> {
  let done = 0;
  for (let n = 0; n < BATCH; n++) {
    const job = await claimNextJob(db, ADMIN_VIEWER, SPONSOR_NOTIFY_KINDS);
    if (!job) break;
    try {
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
