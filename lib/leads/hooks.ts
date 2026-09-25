import type { Lead } from "@/lib/db/queries/leads";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";

/**
 * Called once for every lead created — by the get-quotes confirm route
 * (`app/get-quotes/verify/[token]/confirm`), the only place a lead is made,
 * after the requester's click — in the same transaction that wrote it.
 *
 * A no-op until Task 58 fills it with `allocateLead(tx, viewer, lead.id)`
 * (standing orders, then the board). Callers run it inside a savepoint and
 * log rather than rethrow what it throws: an allocation failure must leave
 * the lead open and the request verified, never roll the click back.
 */
export async function afterLeadCreated(_tx: TestDb, _viewer: Viewer, _lead: Lead): Promise<void> {
  // Task 58: allocation.
}

/**
 * The savepoint-and-log wrapper every caller uses, so the rule above is
 * written once. Returns whether the hook finished.
 */
export async function runAfterLeadCreated(
  tx: TestDb,
  viewer: Viewer,
  lead: Lead,
  /** Test seam: the hook itself. */
  hook: typeof afterLeadCreated = afterLeadCreated,
): Promise<boolean> {
  try {
    await tx.transaction(async (sp) => {
      await hook(sp as unknown as TestDb, viewer, lead);
    });
    return true;
  } catch (e) {
    console.error(`[leads] afterLeadCreated failed for ${lead.id}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
