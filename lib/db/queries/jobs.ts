import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { jobQueue } from "@/lib/db/schema";
import { now } from "@/lib/clock";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

/**
 * The queue's four operations.
 *
 * Claiming is `FOR UPDATE SKIP LOCKED` inside the caller's transaction rather
 * than a `status = 'running'` write: the row lock IS the claim, so a worker
 * that dies mid-job releases it on rollback instead of leaving a job stuck in
 * a running state nobody will ever clear.
 */

/**
 * Retries after the first failure. The sixth failure — the one after the last
 * retry — parks the job: `attempts` then exceeds this and the claim query
 * stops seeing it. A job that can never succeed must stop costing a provider
 * call every tick, and the parked row is the record of why.
 */
export const MAX_JOB_ATTEMPTS = 5;

/** Doubles each time: 1, 2, 4, 8, 16 minutes. */
const BACKOFF_BASE_MS = 60_000;

export interface EnqueueJobInput {
  kind: string;
  payload: Record<string, unknown>;
  /** Defaults to now. Set it to schedule work rather than queue it. */
  runAfter?: Date;
}

export interface QueuedJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  /**
   * Recipient keys an earlier attempt already reached. A handler that sends to
   * more than one address must skip these, or a single failing recipient makes
   * every other one receive a copy per retry.
   */
  delivered: string[];
}

export type FailJobOutcome = { status: "pending" | "failed"; attempts: number };

function assertWorker(viewer: Viewer): void {
  // The payload carries an enquirer's name, address and message. Reading the
  // queue is reading other people's post.
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

/**
 * Enqueue is deliberately ungated: it is called from inside the transaction
 * that writes the thing being notified about, and that write did its own
 * authorisation. A second check here would only be able to say no to a row
 * that has already been accepted.
 */
export async function enqueueJob(
  tx: TestDb,
  _viewer: Viewer,
  input: EnqueueJobInput,
): Promise<string> {
  const [row] = await tx
    .insert(jobQueue)
    .values({
      kind: input.kind,
      payload: input.payload,
      ...(input.runAfter === undefined ? {} : { runAfter: input.runAfter }),
    })
    .returning({ id: jobQueue.id });
  return row!.id;
}

/**
 * Takes the longest-waiting due job of a kind this worker handles and holds it
 * until the caller's transaction ends. `kinds` is required rather than
 * optional so that adding a second consumer later cannot silently hand it work
 * meant for the first.
 */
export async function claimNextJob(
  tx: TestDb,
  viewer: Viewer,
  kinds: string[],
): Promise<QueuedJob | null> {
  assertWorker(viewer);
  if (kinds.length === 0) return null;

  const [row] = await tx
    .select({
      id: jobQueue.id,
      kind: jobQueue.kind,
      payload: jobQueue.payload,
      attempts: jobQueue.attempts,
      delivered: jobQueue.delivered,
    })
    .from(jobQueue)
    .where(and(
      eq(jobQueue.status, "pending"),
      inArray(jobQueue.kind, kinds),
      lte(jobQueue.runAfter, now()),
    ))
    .orderBy(asc(jobQueue.runAfter), asc(jobQueue.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });

  if (!row) return null;
  return {
    ...row,
    payload: row.payload as Record<string, unknown>,
    delivered: Array.isArray(row.delivered) ? row.delivered : [],
  };
}

/**
 * Records which recipients a partly-successful job reached.
 *
 * Written before `failJob` so the retry the failure schedules starts from what
 * has already been sent. The whole list is passed rather than appended in SQL:
 * the caller holds the row lock for the length of its transaction, so there is
 * no second writer to lose an update to, and a plain assignment is one
 * statement the reader can check by eye.
 */
export async function markDelivered(
  tx: TestDb,
  viewer: Viewer,
  id: string,
  delivered: string[],
): Promise<void> {
  assertWorker(viewer);
  await tx
    .update(jobQueue)
    .set({ delivered, updatedAt: now() })
    .where(eq(jobQueue.id, id));
}

export async function completeJob(tx: TestDb, viewer: Viewer, id: string): Promise<void> {
  assertWorker(viewer);
  await tx
    .update(jobQueue)
    .set({ status: "done", finishedAt: now(), lastError: null, updatedAt: now() })
    .where(eq(jobQueue.id, id));
}

/**
 * Records the failure and decides whether the job gets another go. Returns
 * what it decided so the worker can log a park as the event it is rather than
 * as one more failed attempt.
 */
export async function failJob(
  tx: TestDb,
  viewer: Viewer,
  id: string,
  error: string,
): Promise<FailJobOutcome> {
  assertWorker(viewer);

  const at = now();
  const [row] = await tx
    .update(jobQueue)
    .set({ attempts: sql`${jobQueue.attempts} + 1`, lastError: error, updatedAt: at })
    .where(eq(jobQueue.id, id))
    .returning({ attempts: jobQueue.attempts });
  if (!row) throw new Error(`No such job: ${id}`);

  const attempts = row.attempts;
  if (attempts > MAX_JOB_ATTEMPTS) {
    await tx.update(jobQueue).set({ status: "failed", finishedAt: at }).where(eq(jobQueue.id, id));
    return { status: "failed", attempts };
  }

  const runAfter = new Date(at.getTime() + BACKOFF_BASE_MS * 2 ** (attempts - 1));
  await tx.update(jobQueue).set({ runAfter }).where(eq(jobQueue.id, id));
  return { status: "pending", attempts };
}
