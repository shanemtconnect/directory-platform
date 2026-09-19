import { sql, type SQL } from "drizzle-orm";
import { listings } from "@/lib/db/schema";

/**
 * THE ranking expression. Every pillar page, search result and sitemap ordering
 * uses this — if it appears twice in the codebase, that is a bug.
 *
 * Order of precedence:
 *   1. Paid tier. Money buys position; that is the product.
 *   2. rank_boost + backlink_boost. Two columns, deliberately: rank_boost is
 *      the admin's, unbounded in both directions, and backlink_boost is the
 *      badge programme's, written only by the backlink checker. They were one
 *      column once, which meant clamping the sum to 0..5 to stop a weekly job
 *      stacking the reward — and that clamp silently ate a hand-set +40 and
 *      floored an admin's -10 the first time a badge verified. Summed here so
 *      the ordering is still one expression.
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
    sql`(${listings.rankBoost} + ${listings.backlinkBoost}) desc`,
    sql`case ${listings.claimStatus}
          when 'verified' then 25
          when 'claimed' then 10
          else 0
        end desc`,
    sql`md5(${listings.id}::text || (now() at time zone ${timezone})::date::text) asc`,
  ];
}
