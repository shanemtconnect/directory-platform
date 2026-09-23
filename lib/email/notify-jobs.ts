import { enqueueJob } from "@/lib/db/queries/jobs";
import { now } from "@/lib/clock";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";

/**
 * The jobs board's notifications (Task 49).
 *
 * A SEPARATE kind list, drained by `worker/jobs/job-board.ts` rather than by
 * the notify worker — the same shape `BILLING_NOTIFY_KINDS` takes, and for the
 * same reason: `claimNextJob` is handed the kinds its caller handles, so a
 * consumer added here cannot be handed work meant for another, and the notify
 * worker's `run` switch is left untouched by a module it knows nothing about.
 *
 * Payloads are ids, never copies: the worker re-reads the row when it runs.
 *
 * `runAfter: now()` on every enqueue: the producer and the consumer read the
 * same clock. Left to the database default, run_after is the wall clock while
 * claimNextJob compares against lib/clock — a job queued under a moved clock
 * is never due.
 */

/** A new post is waiting in the admin queue. */
export const NOTIFY_JOB_SUBMITTED = "notify.job.submitted";
/** Approved or turned down, going back to the poster. */
export const NOTIFY_JOB_DECIDED = "notify.job.decided";
/** The post closes in `siteConfig.jobs.reminderDays`. */
export const NOTIFY_JOB_EXPIRING = "notify.job.expiring";

export const JOB_BOARD_NOTIFY_KINDS: string[] = [
  NOTIFY_JOB_SUBMITTED,
  NOTIFY_JOB_DECIDED,
  NOTIFY_JOB_EXPIRING,
];

export type JobBoardJobPayload = { jobId: string };

export async function notifyJobSubmitted(tx: TestDb, viewer: Viewer, jobId: string): Promise<void> {
  const payload: JobBoardJobPayload = { jobId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_JOB_SUBMITTED, payload, runAfter: now() });
}

export async function notifyJobDecided(tx: TestDb, viewer: Viewer, jobId: string): Promise<void> {
  const payload: JobBoardJobPayload = { jobId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_JOB_DECIDED, payload, runAfter: now() });
}

export async function notifyJobExpiring(tx: TestDb, viewer: Viewer, jobId: string): Promise<void> {
  const payload: JobBoardJobPayload = { jobId };
  await enqueueJob(tx, viewer, { kind: NOTIFY_JOB_EXPIRING, payload, runAfter: now() });
}
