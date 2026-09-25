import { expireQuoteRequests } from "@/lib/db/queries/quotes";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";

/**
 * `quotes.expire`, hourly (Task 56). A quote request whose requester never
 * clicked the verification link within 48 hours is marked `expired`: it was
 * never sent, never will be, and a late click is told so. The window is
 * enforced at the click as well (`verifyQuoteToken`), so an hour's lag here
 * lets nothing through; this keeps the admin list honest.
 *
 * Returns how many it expired, for the log line.
 */
export async function expirePendingQuotes(db: Db): Promise<number> {
  const n = await expireQuoteRequests(db, ADMIN_VIEWER);
  if (n > 0) console.log(`[worker] expired ${n} unconfirmed quote request(s)`);
  return n;
}
