import { applyBadgeCounters, type BadgeCounterDelta } from "@/lib/db/queries/badges";
import { drainBadgeCounters } from "@/lib/badge/counters";
import { ADMIN_VIEWER } from "../viewer";
import type { Db } from "@/lib/db/client";

/**
 * Moves a minute of badge impressions and clicks out of Redis and into
 * `badges`.
 *
 * The counters are drained — renamed away — before this writes anything, so a
 * throw here loses that minute rather than double-counting it. That is the
 * right way round: these are dashboard numbers, nothing is billed on them, and
 * a flush that could double-count would make them worse than useless.
 */
export async function flushBadgeCounters(
  db: Db,
  deps: { drain?: () => Promise<BadgeCounterDelta[]> } = {},
): Promise<number> {
  const drain = deps.drain ?? drainBadgeCounters;
  const deltas = await drain();
  if (deltas.length === 0) return 0;
  return applyBadgeCounters(db, ADMIN_VIEWER, deltas);
}
