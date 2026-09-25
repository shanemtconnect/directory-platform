import {
  AUTH_TOKEN_TTL_SECONDS,
  NOTIFY_AUTH_RESET,
  NOTIFY_AUTH_VERIFY,
  NOTIFY_AWARD_WON,
  NOTIFY_CLAIM_DECIDED,
  NOTIFY_CLAIM_LINK,
  NOTIFY_CLAIM_SUBMITTED,
  NOTIFY_DECISION,
  NOTIFY_ENQUIRY,
  NOTIFY_KINDS,
  NOTIFY_QUOTE,
  NOTIFY_REMOVAL,
  NOTIFY_REMOVAL_ACTIONED,
  NOTIFY_REMOVAL_REJECTED,
  NOTIFY_REPORT,
  NOTIFY_REVIEW_SUBMITTED,
  NOTIFY_REVIEW_VERIFIED,
  NOTIFY_SAVED_SEARCH,
  NOTIFY_SPOT_CLOSED,
  NOTIFY_SPOT_DIGEST,
  NOTIFY_SPOT_OUTBID,
  NOTIFY_SUBMISSION,
} from "@/lib/email/notify";
import {
  submissionApproved,
  submissionReceived,
  submissionRejected,
  submissionToAdmin,
} from "@/lib/email/templates/submission";
import { siteUrl } from "@/lib/schema/builders";
import {
  claimNextJob,
  completeJob,
  failJob,
  markDelivered,
  type QueuedJob,
} from "@/lib/db/queries/jobs";
import {
  decisionNotification,
  enquiryNotification,
  parkedSubmissionNotification,
  submissionNotification,
  type SubmissionNotification,
} from "@/lib/db/queries/notifications";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { sendEmail, type EmailMessage } from "@/lib/email/sender";
import { enquiryToAdmin, enquiryToOwner } from "@/lib/email/templates/enquiry";
import { removalDecisionNotification, removalNotification, reportNotification } from "@/lib/db/queries/trust";
import {
  removalActioned,
  removalReceived,
  removalRejected,
  removalToAdmin,
  reportToAdmin,
} from "@/lib/email/templates/trust";
import { reviewNotification } from "@/lib/db/queries/reviews";
import { reviewToAdmin, reviewToOwner, reviewVerification } from "@/lib/email/templates/review";
import {
  claimApproved, claimMagicLink, claimRejected, claimToAdmin,
} from "@/lib/email/templates/claim";
import { claimNotification } from "@/lib/db/queries/claims";
import { MAGIC_TOKEN_TTL_MINUTES, isTokenExpired } from "@/lib/claims/token";
import { passwordReset, verifyEmailAddress } from "@/lib/email/templates/auth";
import { authEmailRecipient } from "@/lib/db/queries/profile";
import { awardNotification, awardsCityPath } from "@/lib/db/queries/awards";
import { awardWon } from "@/lib/email/templates/award";
import { hashToken } from "@/lib/security/token-hash";
import type { Db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { formatMoney } from "@/lib/pricing";
import { signUnsubscribe } from "@/lib/email/unsubscribe";
import { describeSpotKeys, listingForSystem, outbidNotification, spotById, spotClosedBid } from "@/lib/db/queries/spots";
import { availabilityForListing, emptySpotsReport } from "@/lib/spots/availability";
import { minimumToEnter, minimumToTakeFirst, UNIT_CENTS } from "@/lib/spots/rank";
import { leaderboardPath, prefilledBidPath } from "@/lib/spots/notify";
import { spotClosedToOwner, spotDigestToAdmin, spotDigestToOwner, spotOutbid } from "@/lib/email/templates/spots";
import { markSavedSearchSent, newMatchesFor, savedSearchForDigest } from "@/lib/db/queries/saved-searches";
import { savedSearchDigest } from "@/lib/email/templates/alerts";
import { savedSearchPath } from "@/lib/alerts/paths";
import { features } from "@/lib/features/flags";
import { now } from "@/lib/clock";

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

/** How much of a failure message reaches the log line. */
const LOGGED_ERROR_CHARS = 200;

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
const CLAIMANT = "claimant";

/**
 * A send that never reached the provider — no key, no address — is not a
 * failure of this job. Retrying it would park every notification a site
 * accumulates before its mail is configured, and lose them.
 */
async function deliver(d: Delivery, key: string, message: EmailMessage): Promise<void> {
  await deliverCounted(d, key, message);
}

/** `deliver`, reporting whether the provider took it — for the one caller that counts sends. */
async function deliverCounted(d: Delivery, key: string, message: EmailMessage): Promise<boolean> {
  // Already sent on an earlier attempt: the retry is for the ones that failed.
  if (d.done.has(key)) return true;

  const result = await sendEmail(message);
  if (!result.sent && result.reason === "rejected") {
    throw new Retryable(result.error ?? "the mail provider rejected the message");
  }
  // Anything that is not a rejection is as done as this recipient will get:
  // the job will not be retried on its account. Whether it actually reached
  // the provider is returned for the one caller that counts sends.
  d.fresh.push(key);
  return result.sent;
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

/**
 * The reply every removal page promises: "we email you when it is done."
 * Requester only — a decision on somebody's own removal request is not the
 * admin's news to receive a second time.
 */
async function runRemovalDecision(
  db: Db,
  d: Delivery,
  payload: Record<string, unknown>,
  build: typeof removalActioned,
): Promise<void> {
  const removalRequestId = readId(payload, "removalRequestId");
  if (removalRequestId === null) throw new Retryable("The job carries no removalRequestId");

  const data = await removalDecisionNotification(db, ADMIN_VIEWER, removalRequestId);
  if (!data) throw new Retryable(`No notifiable removal request ${removalRequestId}`);

  await deliver(d, REQUESTER, {
    to: data.requesterEmail,
    ...build({
      listingName: data.listingName,
      requesterName: data.requesterName,
      rejectionReason: data.rejectionReason,
    }),
  });
}

/**
 * The approve/reject email. One recipient: the person who submitted it.
 *
 * The decision is read from the PAYLOAD rather than from the row's status —
 * see DecisionJobPayload. The row is still re-read for everything else, so the
 * name, town and reason are whatever they are when the email goes out.
 */
async function runDecision(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
  const listingId = readId(payload, "listingId");
  if (listingId === null) throw new Retryable("The job carries no listingId");

  const decision = readId(payload, "decision");
  if (decision !== "approved" && decision !== "rejected") {
    throw new Retryable(`The job carries no decision to send (${String(decision)})`);
  }

  const data = await decisionNotification(db, ADMIN_VIEWER, listingId);
  if (!data) throw new Retryable(`No notifiable submitter on listing ${listingId}`);

  const content = {
    listingName: data.listingName,
    cityName: data.cityName,
    listingUrl: siteUrl(data.listingPath),
    submitter: data.submitter,
  };

  const message =
    decision === "approved"
      ? submissionApproved(content)
      : submissionRejected({ ...content, reason: data.rejectedReason });

  await deliver(d, SUBMITTER, { to: data.submitter.email, ...message });
}

/**
 * The three claim notifications.
 *
 * All of them re-read the claim rather than trusting the payload for anything
 * but the token itself, so a link that has since been replaced by a resend is
 * never the one that goes out, and a decision that has since been changed is
 * never announced twice differently.
 */
async function runClaim(db: Db, d: Delivery, kind: string, payload: Record<string, unknown>): Promise<void> {
  const claimId = readId(payload, "claimId");
  if (claimId === null) throw new Retryable("The job carries no claimId");

  const claim = await claimNotification(db, ADMIN_VIEWER, claimId);
  if (!claim) throw new Retryable(`No such claim ${claimId}`);

  const listing = { listingName: claim.listingName, listingUrl: siteUrl(claim.listingPath) };

  if (kind === NOTIFY_CLAIM_LINK) {
    // Nothing to send, and nothing to retry. A claim that has been decided
    // since the job was enqueued — approved from the other rung, rejected,
    // withdrawn — or whose token has aged out while the worker was behind, has
    // no live credential. Retrying would bury the log and then fail the job;
    // mailing a spent link would send somebody to a dead page. Complete.
    if (claim.status !== "pending" || isTokenExpired(claim.magicTokenExpiresAt)) return;
    if (claim.magicTokenHash === null || claim.businessEmail === null) {
      throw new Retryable("The claim has no live magic link to send");
    }
    // The token comes from the payload: the row holds only its digest. A job
    // without one cannot send anything that works, and says so in last_error
    // — without the token, which is never written anywhere but the email.
    const token = readId(payload, "token");
    if (token === null) throw new Retryable("The job carries no token");
    // A resend minted a newer link after this job was queued: that job sends
    // it, and this one has nothing live to send. Complete, do not retry.
    if (hashToken(token) !== claim.magicTokenHash) return;
    // Only ever to the address on the business's own domain. Copying an admin
    // would hand a credential to somebody the claimant never authorised.
    return deliver(d, CLAIMANT, {
      to: claim.businessEmail,
      ...claimMagicLink({
        ...listing,
        verifyUrl: siteUrl(`/claim/verify/${encodeURIComponent(token)}`),
        expiresInMinutes: MAGIC_TOKEN_TTL_MINUTES,
      }),
    });
  }

  if (kind === NOTIFY_CLAIM_SUBMITTED) {
    return deliver(d, ADMIN, {
      to: adminAddress(),
      ...claimToAdmin({
        ...listing,
        claimantName: claim.claimantName,
        claimantEmail: claim.accountEmail ?? claim.businessEmail,
        reviewUrl: siteUrl(`/admin/claims/${claim.claimId}`),
      }),
    });
  }

  // NOTIFY_CLAIM_DECIDED. The account that asked is told, not the business
  // address: a rejection going to a shared inbox tells the business somebody
  // tried to take their listing, which is not ours to broadcast.
  const to = claim.accountEmail ?? claim.businessEmail;
  if (to === null) throw new Retryable("The claim has nobody to tell");
  if (claim.status === "approved") {
    return deliver(d, CLAIMANT, {
      to,
      ...claimApproved({ ...listing, dashboardUrl: siteUrl("/account") }),
    });
  }
  if (claim.status === "rejected") {
    return deliver(d, CLAIMANT, {
      to,
      ...claimRejected({ ...listing, reason: claim.rejectionReason ?? "" }),
    });
  }
  // Enqueued inside the deciding transaction, so a claim that is still pending
  // means the decision rolled back. Retrying is right: the next attempt reads
  // whatever the database settled on.
  throw new Retryable(`Claim ${claimId} has no decision to announce`);
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
    case NOTIFY_REMOVAL_ACTIONED:
      return runRemovalDecision(db, d, job.payload, removalActioned);
    case NOTIFY_REMOVAL_REJECTED:
      return runRemovalDecision(db, d, job.payload, removalRejected);
    case NOTIFY_DECISION:
      return runDecision(db, d, job.payload);
    // Appended by the reviews module; the handler is at the foot of the file.
    case NOTIFY_REVIEW_SUBMITTED:
      return runReviewSubmitted(db, d, job.payload);
    case NOTIFY_REVIEW_VERIFIED:
      return runReviewVerified(db, d, job.payload);
    case NOTIFY_CLAIM_LINK:
    case NOTIFY_CLAIM_SUBMITTED:
    case NOTIFY_CLAIM_DECIDED:
      return runClaim(db, d, job.kind, job.payload);
    case NOTIFY_AUTH_RESET:
      return runAuthEmail(db, d, job.payload, passwordReset, passwordResetLink);
    case NOTIFY_AUTH_VERIFY:
      return runAuthEmail(db, d, job.payload, verifyEmailAddress, verifyEmailLink);
    // Appended by the quotes module; the handler is at the foot of the file.
    case NOTIFY_QUOTE:
      return runQuote(db, d, job.payload);
    // Appended by the awards module; the handler is at the foot of the file.
    case NOTIFY_AWARD_WON:
      return runAwardWon(db, d, job.payload);
    // Appended by the featured-spots module (Task 45); handlers at the foot.
    case NOTIFY_SPOT_OUTBID:
      return runSpotOutbid(db, d, job.payload);
    case NOTIFY_SPOT_DIGEST:
      return runSpotDigest(db, d, job.payload);
    case NOTIFY_SPOT_CLOSED:
      return runSpotClosed(db, d, job.payload);
    // Appended by the saved-searches module (Task 54); handler at the foot.
    case NOTIFY_SAVED_SEARCH:
      return runSavedSearch(db, d, job.payload);
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
      // Truncated for the log: a mailer's error can quote the request it
      // rejected, recipient address and all, and a log line is shipped to
      // places a queue row is not. The full text is in `last_error`.
      console.error(
        `[worker] ${job.kind} ${job.id} ${outcome.status === "failed" ? "PARKED" : "failed"}` +
          ` after ${outcome.attempts}: ${message.slice(0, LOGGED_ERROR_CHARS)}`,
      );
    }
  }

  return done;
}

/* ------------------------------------------------------ reviews (Task 22) */

/**
 * A fourth recipient role. It has to be a stable string across attempts for
 * the same reason the other three do: it is what stops a retry sending the
 * verification link twice.
 */
const REVIEWER = "reviewer";

/** Reviews live under the listing they are about. */
function reviewsUrl(listingPath: string): string {
  return siteUrl(`${listingPath}/reviews`);
}

/**
 * The verification link.
 *
 * A review with no live token has already been verified — someone clicked the
 * link before the queue drained, or a retry is running after the fact — and
 * there is nothing left to send. That is a completed job, not a failure: a
 * retry would only re-send a link that no longer works. The same goes for a
 * link a resend has since replaced: the newer job sends the newer link.
 *
 * The token itself comes from the payload; the invite row holds its digest.
 */
async function runReviewSubmitted(
  db: Db, d: Delivery, payload: Record<string, unknown>,
): Promise<void> {
  const reviewId = readId(payload, "reviewId");
  if (reviewId === null) throw new Retryable("The job carries no reviewId");

  const data = await reviewNotification(db, ADMIN_VIEWER, reviewId);
  if (!data) throw new Retryable(`No review ${reviewId}`);
  if (data.tokenHash === null) return;

  const token = readId(payload, "token");
  if (token === null) throw new Retryable("The job carries no token");
  if (hashToken(token) !== data.tokenHash) return;

  await deliver(d, REVIEWER, {
    to: data.authorEmail,
    ...reviewVerification({
      listingName: data.listing.name,
      listingUrl: siteUrl(data.listing.path),
      reviewsUrl: reviewsUrl(data.listing.path),
      verifyUrl: siteUrl(`/review/verify/${encodeURIComponent(token)}`),
      author: data.authorDisplayName ?? "",
      rating: data.rating,
      title: data.title,
      body: data.body,
      flaggedReason: data.flaggedReason,
    }),
  });
}

/**
 * What the click decided.
 *
 * The owner hears about it only when the review is actually on the page and
 * only when the listing is claimed — the same rule the enquiry handler uses,
 * and for the same reason: an unclaimed listing's contact address is one we
 * hold, not one anybody asked us to write to.
 */
async function runReviewVerified(
  db: Db, d: Delivery, payload: Record<string, unknown>,
): Promise<void> {
  const reviewId = readId(payload, "reviewId");
  if (reviewId === null) throw new Retryable("The job carries no reviewId");

  const data = await reviewNotification(db, ADMIN_VIEWER, reviewId);
  if (!data) throw new Retryable(`No review ${reviewId}`);

  const content = {
    listingName: data.listing.name,
    listingUrl: siteUrl(data.listing.path),
    reviewsUrl: reviewsUrl(data.listing.path),
    // The link is spent by the time this job runs; nothing in these two
    // emails uses it, and it must not be re-published to anyone.
    verifyUrl: siteUrl(data.listing.path),
    author: data.authorDisplayName ?? "",
    rating: data.rating,
    title: data.title,
    body: data.body,
    flaggedReason: data.flaggedReason,
  };

  if (
    data.status === "published" &&
    data.listing.claimed &&
    data.listing.email !== null &&
    data.listing.email.trim() !== ""
  ) {
    await deliver(d, OWNER, { to: data.listing.email, ...reviewToOwner(content) });
  }

  await deliver(d, ADMIN, { to: adminAddress(), ...reviewToAdmin(content) });
}

/*
 * ---------------------------------------------------------------------------
 * Auth emails (password reset, address verification).
 *
 * A self-contained tail: the handlers live here, their imports in the
 * header with everything else's.
 * ---------------------------------------------------------------------------
 */
import { passwordResetLink, verifyEmailLink } from "@/lib/auth/links";

const ACCOUNT = "account";

/**
 * How long the links in these two emails last, stated in the body.
 *
 * It has to agree with `resetPasswordTokenExpiresIn` and
 * `emailVerification.expiresIn` in lib/auth/server.ts, which is why both read
 * AUTH_TOKEN_TTL_SECONDS rather than each naming an hour.
 */
const TOKEN_TTL_MINUTES = Math.round(AUTH_TOKEN_TTL_SECONDS / 60);

/**
 * A password reset or an address confirmation. One recipient — the account
 * itself — and deliberately no admin copy: a working reset link in our own
 * inbox is a way into somebody else's account.
 *
 * The link is built HERE, from the payload's token and our own origin. The
 * payload reaches this function through a jsonb column, and anything that can
 * write a row in `job_queue` would otherwise be writing the href of a link we
 * send, signed with our domain, to an address we look up for it. That is a
 * phishing kit, not a notification — so a `url` in the payload is not read.
 *
 * Nothing thrown from here names the token: `last_error` is a column an admin
 * reads, and a log line is a place a reset link must never appear.
 */
async function runAuthEmail(
  db: Db,
  d: Delivery,
  payload: Record<string, unknown>,
  build: typeof passwordReset,
  link: (token: string) => string,
): Promise<void> {
  const userId = readId(payload, "userId");
  if (userId === null) throw new Retryable("The job carries no userId");

  const token = readId(payload, "token");
  if (token === null) throw new Retryable("The job carries no token");

  let url: string;
  try {
    url = link(token);
  } catch (e) {
    // Only ever "no origin configured"; the message carries no token.
    throw new Retryable(e instanceof Error ? e.message : "The link could not be built");
  }

  const recipient = await authEmailRecipient(db, ADMIN_VIEWER, userId);
  // Not retryable: the account has gone, so there is nobody to tell and
  // nothing a later attempt could do about it.
  if (!recipient) return;

  await deliver(d, ACCOUNT, {
    to: recipient.email,
    ...build({ name: recipient.name, url, expiresInMinutes: TOKEN_TTL_MINUTES }),
  });
}

/* ------------------------------------------------------- quotes (Task 47) */

import { quoteNotification } from "@/lib/db/queries/quotes";
import { quoteAcknowledgement, quoteToRecipient } from "@/lib/email/templates/quotes";

/**
 * One request, many recipients, one job.
 *
 * Each recipient is its own delivery key — `recipient:<listingId>`, stable
 * across attempts — and a rejection is caught per recipient so a bad address
 * on the second of five never holds up the third, the fourth, the fifth or
 * the requester. The first rejection is rethrown once everyone else has been
 * tried, so the retry (with `d.fresh` already recorded) sends only the
 * rejected ones again. The requester's acknowledgement goes LAST and says
 * how many actually reached the provider: the number on the form was the
 * number chosen, and an unsubscribe, a lost address, a rejection or a mailer
 * that is not configured is not something to pad over.
 */
async function runQuote(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
  const quoteRequestId = readId(payload, "quoteRequestId");
  if (quoteRequestId === null) throw new Retryable("The job carries no quoteRequestId");

  const data = await quoteNotification(db, ADMIN_VIEWER, quoteRequestId);
  // Flagged as spam, or gone: nothing to send, and the job is done.
  if (!data) return;

  let delivered = 0;
  let firstFailure: Error | null = null;
  for (const r of data.recipients) {
    // No address (the listing lost its email, or its owner's account went) or
    // an unsubscribe: skipped, not retried. The next tick would find the same.
    if (r.email === null || r.unsubscribed) continue;
    try {
      const sent = await deliverCounted(d, `recipient:${r.listingId}`, {
        to: r.email,
        ...quoteToRecipient({
          listingName: r.listingName,
          leadsUrl: siteUrl(`/account/listings/${r.listingId}/leads`),
          pricingUrl: siteUrl("/pricing"),
          cityName: data.cityName,
          categoryName: data.categoryName,
          contactVisible: r.contactVisible,
          requester: data.requester,
          message: data.message,
          unsubscribeToken: signUnsubscribe({ email: r.email, listingId: r.listingId }),
        }),
      });
      if (sent) delivered++;
    } catch (e) {
      firstFailure ??= e instanceof Error ? e : new Error(String(e));
    }
  }

  await deliver(d, REQUESTER, {
    to: data.requester.email,
    ...quoteAcknowledgement({
      requesterName: data.requester.name,
      cityName: data.cityName,
      categoryName: data.categoryName,
      recipientCount: delivered,
      message: data.message,
    }),
  });

  if (firstFailure !== null) throw firstFailure;
}

/* ------------------------------------------------------- awards (Task 50) */

/** The winner. One recipient, one stable key, like the others. */
const WINNER = "winner";

/**
 * "You won". The award is re-read at send time: one revoked between the run
 * and the tick is a completed job with nothing to send, not a retry, and a
 * winner with no address on file (an unclaimed listing with no contact email)
 * is the same — there is nobody to tell and no attempt that would change it.
 */
async function runAwardWon(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
  const awardId = readId(payload, "awardId");
  if (awardId === null) throw new Retryable("The job carries no awardId");

  const data = await awardNotification(db, ADMIN_VIEWER, awardId);
  if (!data) throw new Retryable(`No award ${awardId}`);
  if (data.revoked || data.recipient === null) return;

  await deliver(d, WINNER, {
    to: data.recipient,
    ...awardWon({
      year: data.year,
      listingName: data.listingName,
      listingUrl: siteUrl(data.listingPath),
      awardsUrl: siteUrl(awardsCityPath(data.year, data.citySlug)),
      cityName: data.cityName,
      categoryName: data.categoryName,
      badgeUrl: siteUrl("/advertise/badge"),
    }),
  });
}

/* ------------------------------------------------ featured spots (Task 45) */

const spotMoney = (cents: number) => formatMoney(cents / UNIT_CENTS, siteConfig.locale, siteConfig.currency);
const spotLabelOf = (areaName: string, categoryName: string | null) =>
  categoryName === null ? areaName : `${categoryName} in ${areaName}`;

/**
 * The outbid email, from the bid AS IT STANDS when the job runs. The
 * payload's `kind` is the reason the job exists; the sentence sent is
 * derived from the position the bid holds NOW (I2): none → "no longer
 * featured" with the amount to re-enter; below first → "lost first" with the
 * amount to retake it; first → nothing, and a cancelled, pending or vanished
 * bid, or one with nobody to write to, completes without a send.
 */
async function runSpotOutbid(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
  const bidId = readId(payload, "bidId");
  if (bidId === null) throw new Retryable("The job carries no bidId");
  const data = await outbidNotification(db, ADMIN_VIEWER, bidId);
  // A bid only vanishes with its listing; there is nobody left to tell.
  if (data === null) return;
  if (data.status === "cancelled" || data.status === "pending") return;
  if (data.position === 1) return;
  if (data.ownerEmail === null) {
    console.warn(`[worker] featured bid ${bidId} has no owner address to write to`);
    return;
  }
  const kind = data.position === null ? "dropped-out" : "lost-first";
  const standing = { floorCents: data.spot.floorCents, positions: data.spot.positions, featured: data.featuredOthers };
  const amountCents = kind === "lost-first" ? minimumToTakeFirst(standing) : minimumToEnter(standing);
  const keyString = `${data.spotKey.areaKind}:${data.spotKey.areaId}:${data.spotKey.categoryId ?? "-"}`;
  await deliver(d, OWNER, {
    to: data.ownerEmail,
    ...spotOutbid({
      listingName: data.listingName,
      spotLabel: spotLabelOf(data.areaName, data.categoryName),
      kind,
      position: data.position,
      positions: data.spot.positions,
      amount: spotMoney(amountCents),
      bidUrl: siteUrl(prefilledBidPath(data.listingId, keyString, amountCents / UNIT_CENTS)),
      leaderboardUrl: siteUrl(leaderboardPath(data.spot.id)),
    }),
  });
}

/** The site closed a spot: the owner of every bid that was on it hears why (I3). */
async function runSpotClosed(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
  const listingId = readId(payload, "listingId");
  const spotId = readId(payload, "spotId");
  if (listingId === null || spotId === null) throw new Retryable("The job carries no listingId or spotId");
  const [listing, spot, bid] = await Promise.all([
    listingForSystem(db, ADMIN_VIEWER, listingId),
    spotById(db, ADMIN_VIEWER, spotId),
    spotClosedBid(db, ADMIN_VIEWER, { listingId, spotId }),
  ]);
  if (listing === null || spot === null || bid === null) return;
  if (listing.ownerEmail === null) {
    console.warn(`[worker] listing ${listingId} has no owner address to write to about the closed spot`);
    return;
  }
  const [area] = await describeSpotKeys(db, ADMIN_VIEWER, [{ areaKind: spot.areaKind, areaId: spot.areaId, categoryId: spot.categoryId }]);
  await deliver(d, OWNER, {
    to: listing.ownerEmail,
    ...spotClosedToOwner({
      listingName: listing.name,
      spotLabel: spotLabelOf(area?.areaName ?? spot.areaId, area?.categoryName ?? null),
      amount: spotMoney(bid.amountCents),
      bidUrl: siteUrl(`/account/listings/${listingId}/featured`),
    }),
  });
}

/**
 * The monthly digest, recomputed at send time. An owner job whose listing
 * has no empty spot any more (or whose address has unsubscribed since the
 * job was queued) completes without a send. The admin job is the site-wide
 * table.
 */
async function runSpotDigest(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
  if (payload.admin === true) {
    const report = await emptySpotsReport(db, ADMIN_VIEWER);
    const empty = report.filter((r) => r.status === "open" && r.filled < r.positions);
    await deliver(d, ADMIN, {
      to: adminAddress(),
      ...spotDigestToAdmin({
        total: empty.length,
        rows: empty.map((r) => ({
          label: spotLabelOf(r.areaName, r.categoryName),
          filled: r.filled,
          positions: r.positions,
          floor: spotMoney(r.floorCents),
          top: r.topCents === null ? "—" : spotMoney(r.topCents),
        })),
        csvUrl: siteUrl("/admin/spots/export"),
      }),
    });
    return;
  }
  const listingId = readId(payload, "listingId");
  if (listingId === null) throw new Retryable("The job carries no listingId");
  const a = await availabilityForListing(db, ADMIN_VIEWER, listingId);
  if (a === null || a.emptyCount === 0 || a.ownerEmail === null || a.unsubscribed) return;
  const token = signUnsubscribe({ email: a.ownerEmail, listingId });
  await deliver(d, OWNER, {
    to: a.ownerEmail,
    ...spotDigestToOwner({
      listingName: a.listingName,
      emptyCount: a.emptyCount,
      fromAmount: spotMoney(a.fromCents),
      bidUrl: siteUrl(`/account/listings/${listingId}/featured`),
      unsubscribeToken: token,
    }),
  });
}

/* ------------------------------------------------ saved searches (Task 54) */

/** The person who saved the search. One recipient, one stable key. */
const SUBSCRIBER = "subscriber";

/**
 * One saved search's digest. Everything is re-read here rather than trusted
 * from the dispatch an hour ago: a search deleted, unsubscribed or whose
 * owner is no longer verified completes with nothing sent, and the matches
 * are recomputed through the public query, so a listing unpublished in
 * between never reaches the email. Nothing new by now: nothing sent, and
 * the watermark stays where it was.
 *
 * The watermark moves to the newest `created_at` the digest covered — not
 * to "now" — so a row committed while this ran is still new next time.
 */
async function runSavedSearch(db: Db, d: Delivery, payload: Record<string, unknown>): Promise<void> {
  // Flag off since the job was queued: the module is gone, and so is the mail.
  if (!features.savedSearches) return;
  const savedSearchId = readId(payload, "savedSearchId");
  if (savedSearchId === null) throw new Retryable("The job carries no savedSearchId");

  const data = await savedSearchForDigest(db, ADMIN_VIEWER, savedSearchId);
  if (data === null) return;
  if (data.search.kind === "jobs" && !features.jobBoard) return;

  const matches = await newMatchesFor(db, data.search, data.search.lastSeenCreatedAt);
  if (matches.length === 0) return;

  // Every digest carries its unsubscribe link; one that cannot is not sent.
  const token = signUnsubscribe({ savedSearchId, email: data.email });
  if (token === null) throw new Retryable("No unsubscribe key (EMAIL_UNSUBSCRIBE_SECRET / BETTER_AUTH_SECRET)");

  await deliver(d, SUBSCRIBER, {
    to: data.email,
    ...savedSearchDigest({
      kind: data.search.kind,
      label: data.search.label,
      matches: matches.map((m) => ({ title: m.title, url: siteUrl(m.path), place: m.place })),
      searchUrl: siteUrl(savedSearchPath(data.search.kind, data.search.params)),
      manageUrl: siteUrl("/account/alerts"),
      unsubscribeToken: token,
    }),
  });

  const newest = matches.reduce((max, m) => (m.createdAt > max ? m.createdAt : max), matches[0]!.createdAt);
  await markSavedSearchSent(db, ADMIN_VIEWER, savedSearchId, { sentAt: now(), lastSeenCreatedAt: newest });
}

