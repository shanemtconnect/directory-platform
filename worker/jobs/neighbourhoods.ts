import { ADMIN_VIEWER } from "@/worker/viewer";
import { claimNextJob, completeJob, failJob } from "@/lib/db/queries/jobs";
import { assignNeighbourhoods, NEIGHBOURHOODS_ASSIGN_KIND } from "@/lib/db/queries/neighbourhoods";
import { neighbourhoodsEnabled } from "@/lib/geo/neighbourhoods";
import type { Db } from "@/lib/db/client";
import type { TestDb } from "@/lib/db/types";

/**
 * Neighbourhood assignment (Task 52), `neighbourhoods.assign`.
 *
 * Nightly, every town with neighbourhoods: each listing's `area_id` becomes
 * the nearest centroid within its radius, or null, and each neighbourhood's
 * cached count is refreshed (lib/db/queries/neighbourhoods.ts). The admin
 * "assign now" button queues the same run on `job_queue`; the worker drains
 * it every minute so an import can be checked straight away.
 *
 * With the module off both are no-ops — a queued job simply waits, and runs
 * if the module is turned back on.
 */

/** 02:41 nightly, off the hour and clear of the 03:00–04:00 purges. */
export const NEIGHBOURHOODS_CRON = "41 2 * * *";

/** Queued "assign now" presses settled per tick. They collapse into one run. */
const BATCH = 20;

export async function runNeighbourhoodAssign(
  db: Db,
  enabled: boolean = neighbourhoodsEnabled(),
): Promise<{ revalidate: string[] }> {
  if (!enabled) return { revalidate: [] };
  const out = await assignNeighbourhoods(db as unknown as TestDb, ADMIN_VIEWER);
  if (out.cities > 0) {
    console.log(`[worker] neighbourhoods.assign: ${out.cities} town(s), ${out.changed} listing(s) moved`);
  }
  return { revalidate: out.revalidate };
}

/**
 * Takes the oldest queued press, runs the assignment once, then marks every
 * other press already waiting as done too: two presses a second apart want
 * the same answer, not two identical runs. Claimed one at a time because a
 * row this transaction has already locked is not skipped by SKIP LOCKED — a
 * second claim before the first is completed hands back the same row.
 */
export async function drainNeighbourhoodQueue(
  db: Db,
  enabled: boolean = neighbourhoodsEnabled(),
): Promise<{ revalidate: string[] }> {
  if (!enabled) return { revalidate: [] };
  const handle = db as unknown as TestDb;

  const first = await claimNextJob(handle, ADMIN_VIEWER, [NEIGHBOURHOODS_ASSIGN_KIND]);
  if (!first) return { revalidate: [] };

  let revalidate: string[];
  try {
    // A savepoint, as notify.ts takes per job: a failed run rolls back its
    // own writes and the job is marked failed (and retried) below.
    revalidate = await db.transaction(
      async (sp) => (await runNeighbourhoodAssign(sp as unknown as Db, true)).revalidate,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await failJob(handle, ADMIN_VIEWER, first.id, message);
    console.error(`[worker] ${NEIGHBOURHOODS_ASSIGN_KIND} failed: ${message.slice(0, 200)}`);
    return { revalidate: [] };
  }
  await completeJob(handle, ADMIN_VIEWER, first.id);

  for (let n = 1; n < BATCH; n++) {
    const next = await claimNextJob(handle, ADMIN_VIEWER, [NEIGHBOURHOODS_ASSIGN_KIND]);
    if (!next) break;
    await completeJob(handle, ADMIN_VIEWER, next.id);
  }
  return { revalidate };
}
