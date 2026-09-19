import { purgeFinishedJobs as deleteFinishedJobs } from "@/lib/db/queries/jobs";
import { now } from "@/lib/clock";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * Deletes finished queue rows — done or parked — a week after they finished.
 *
 * A finished job is a record, not work: nothing reads its payload again. The
 * record is worth a week (the health page counts recent runs, and a parked
 * job's `last_error` is how a mailer problem gets noticed) and nothing after
 * that. Left alone the table grows for ever, the claim query's index gets
 * slower, and a pile of ids referencing people and their reviews outlives
 * every reason it existed. The payload is already scrubbed to ids by the time
 * a job finishes (lib/db/queries/jobs.ts); this is what removes the ids.
 *
 * The cutoff comes from `now()` rather than SQL `interval`, so the window can
 * be tested by moving the clock instead of waiting a week.
 */
export const FINISHED_JOB_RETENTION_DAYS = 7;

/** Returns how many rows went, for the worker's log line. */
export async function purgeFinishedJobs(db: Db): Promise<number> {
  const cutoff = new Date(now().getTime() - FINISHED_JOB_RETENTION_DAYS * 86_400_000);
  const gone = await deleteFinishedJobs(db, ADMIN_VIEWER, cutoff);
  if (gone > 0) {
    console.log(
      `[worker] purged ${gone} finished job(s) older than ${FINISHED_JOB_RETENTION_DAYS} days`,
    );
  }
  return gone;
}
