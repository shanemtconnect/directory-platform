import { drainSponsorStats } from "@/lib/ads/counters";
import { applySponsorStatDeltas } from "@/lib/db/queries/ads";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * Redis → `sponsor_stats_daily`, every five minutes, beside `flush-stats`.
 * Returns how many rows were written.
 */
export async function flushSponsorStats(tx: Db): Promise<number> {
  const deltas = await drainSponsorStats();
  if (deltas.length === 0) return 0;
  return applySponsorStatDeltas(tx, ADMIN_VIEWER, deltas);
}
