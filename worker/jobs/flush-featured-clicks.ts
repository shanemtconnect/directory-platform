import { drainFeaturedClicks } from "@/lib/spots/clicks";
import { applyFeaturedClickDeltas } from "@/lib/db/queries/spots";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";
import type { TestDb } from "@/lib/db/types";

/**
 * Redis → `featured_clicks_daily`, every five minutes, beside the other two
 * flushes. Returns how many rows were written.
 */
export async function flushFeaturedClicks(tx: Db | TestDb): Promise<number> {
  const deltas = await drainFeaturedClicks();
  if (deltas.length === 0) return 0;
  return applyFeaturedClickDeltas(tx as TestDb, ADMIN_VIEWER, deltas);
}
