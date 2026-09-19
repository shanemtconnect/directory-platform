import { drainStats } from "@/lib/stats/counters";
import { applyStatDeltas } from "@/lib/db/queries/stats";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * Folds the Redis counters into `listing_stats_daily`.
 *
 * Runs inside the transaction `withAdvisoryLock` opens, so two containers
 * cannot flush at once and a crash after the drain rolls the write back.
 *
 * The one thing this job cannot make atomic is the pair: the counters leave
 * Redis (GETDEL) before the row is written, so a crash between the two loses
 * one tick's counts. That is the deliberate choice over the alternative —
 * leaving the keys until the commit is acknowledged — which double-counts
 * whenever the write succeeded and the acknowledgement did not. Five minutes
 * of view counts is a number nobody can tell is missing; a number that
 * silently doubles is one an owner is later asked to pay against.
 *
 * @returns how many (listing, day) rows were written.
 */
export async function flushStats(tx: Db): Promise<number> {
  const deltas = await drainStats();
  if (deltas.length === 0) return 0;
  return applyStatDeltas(tx, ADMIN_VIEWER, deltas);
}
