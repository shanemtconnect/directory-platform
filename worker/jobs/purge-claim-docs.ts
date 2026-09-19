import {
  DOCUMENT_RETENTION_DAYS,
  claimsWithPurgeableDocuments,
  markClaimDocumentsPurged,
} from "@/lib/db/queries/claims";
import { claimDocsConfigured, deleteClaimDoc } from "@/lib/media/claim-docs";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * Deletes claim documents thirty days after the claim was decided.
 *
 * This is the promise the claim page makes, and a promise about personal data
 * that nothing enforces is a lie with a timestamp on it. A utility bill
 * uploaded to prove control of a business has no purpose once the decision is
 * made; keeping it is a liability and nothing else.
 *
 * The cutoff comes from `now()` rather than SQL `interval`, so the whole
 * retention window can be tested by moving the clock instead of waiting a
 * month.
 */

let warnedUnconfigured = false;

/** Returns how many claims were cleared, for the worker's log line. */
export async function purgeClaimDocuments(db: Db): Promise<number> {
  if (!claimDocsConfigured()) {
    // Local and staging today. Nothing was ever uploaded, so there is nothing
    // to delete — and a job that threw here every tick would bury the log.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn("[worker] R2 is unset — claim documents cannot be purged");
    }
    return 0;
  }

  const due = await claimsWithPurgeableDocuments(db, ADMIN_VIEWER);
  let cleared = 0;

  for (const claim of due) {
    try {
      // Objects first, row second. In the other order a failed delete leaves a
      // document in the bucket that the database swears is gone — which is
      // exactly the state nobody would ever find again.
      for (const path of claim.paths) await deleteClaimDoc(path);
    } catch (e) {
      // Per claim, so one unreachable object does not park the whole sweep.
      // The row keeps its paths and the next tick tries again.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[worker] purge-claim-docs could not clear claim ${claim.id}: ${message}`);
      continue;
    }

    await db.transaction(async (tx) => {
      await markClaimDocumentsPurged(tx as unknown as Db, ADMIN_VIEWER, claim.id, claim.paths);
    });
    cleared++;
  }

  if (cleared > 0) {
    console.log(
      `[worker] purged documents for ${cleared} claim(s) decided over ` +
        `${DOCUMENT_RETENTION_DAYS} days ago`,
    );
  }
  return cleared;
}
