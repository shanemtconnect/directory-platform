import { sql, type SQL } from "drizzle-orm";
import { listings } from "@/lib/db/schema";

/**
 * THE ranking expression. Every pillar page, search result and sitemap ordering
 * uses this — if it appears twice in the codebase, that is a bug.
 *
 * Order of precedence:
 *   1. Paid tier. Money buys position; that is the product.
 *   2. rank_boost. Manual admin lever, plus the backlink reward.
 *   3. Claim status. Verified > claimed > unclaimed, and deliberately BELOW
 *      tier so a paid listing is never outranked by an unpaid verified one.
 *   4. A daily shuffle, stable within the day.
 *
 * The shuffle matters more than it looks: without it the same free listings sit
 * at the bottom forever, never get seen, and never convert. It is pinned to the
 * site's configured timezone so it cannot flip at server-local midnight in the
 * middle of an ISR window.
 */
export function listingRankOrder(timezone: string): SQL[] {
  return [
    sql`case ${listings.tier}
          when 'premium' then 30
          when 'essential' then 20
          else 10
        end desc`,
    sql`${listings.rankBoost} desc`,
    sql`case ${listings.claimStatus}
          when 'verified' then 25
          when 'claimed' then 10
          else 0
        end desc`,
    sql`md5(${listings.id}::text || (now() at time zone ${timezone})::date::text) asc`,
  ];
}
