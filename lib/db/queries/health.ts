import { gte, sql } from "drizzle-orm";
import { jobQueue, jobRuns } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import type { HeartbeatCounts } from "@/lib/observability/heartbeat";

/**
 * Operational reads: is the database there, and is the queue moving.
 *
 * Both live here rather than in the route handler and the worker because
 * global constraint 6 puts every Drizzle call behind `lib/db/queries/`. Neither
 * takes a `Viewer`, which is the exception the rest of that constraint exists
 * to prevent — so, explicitly:
 *
 *  - `pingDatabase` reads no rows at all. There is nothing to authorise.
 *  - `jobCounts` returns row COUNTS grouped by status and nothing else: no ids,
 *    no payloads, no enquirer names. `lib/db/queries/jobs.ts` gates reading the
 *    queue on `isAdmin` precisely because its payloads are other people's post;
 *    a count of how many exist carries none of it, and both callers here run
 *    inside the container (a health check and the worker's own tick).
 *
 * If either ever grows a field that identifies a row, it needs a viewer.
 */

/**
 * Rejects when the database is unreachable. `select 1` rather than a real
 * table: it needs no schema, touches no data, and cannot start failing because
 * a migration is halfway applied — which is exactly the moment a health check
 * has to keep working.
 */
export async function pingDatabase(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

/**
 * `count(*)` arrives from postgres.js as a string (Postgres `bigint` does not
 * fit a JS number, so the driver refuses to guess). Cast in SQL rather than
 * parsing in JS: these are counts of rows in one table, integer range is not in
 * question, and a `pending=3` that is secretly `"3"` hides itself until
 * something adds two of them together.
 */
const countInt = sql<number>`count(*)::int`;

function tally(rows: readonly { status: string; n: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/**
 * @param since start of the window for `job_runs`. The queue counts are all
 *   time — a job stuck pending for a week is the thing worth seeing — while a
 *   run count is only meaningful against an interval.
 */
export async function jobCounts(db: Db, since: Date): Promise<HeartbeatCounts> {
  const [queue, runs] = await Promise.all([
    db
      .select({ status: jobQueue.status, n: countInt })
      .from(jobQueue)
      .groupBy(jobQueue.status),
    db
      .select({ status: jobRuns.status, n: countInt })
      .from(jobRuns)
      .where(gte(jobRuns.startedAt, since))
      .groupBy(jobRuns.status),
  ]);

  return { queue: tally(queue), runs: tally(runs) };
}
