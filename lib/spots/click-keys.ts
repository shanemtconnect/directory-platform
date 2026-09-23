import { isDayKey, isUuid } from "@/lib/stats/keys";

/**
 * The vocabulary of featured clicks (Task 45): the metric name the beacon
 * carries, the per-beacon cap, and the Redis key format. Free of Redis and
 * the database so the inline beacon script and the pillar page tree can
 * import it without pulling `lib/stats/redis` in — the same split as
 * `lib/ads/keys` / `lib/ads/counters`.
 */

export const FEATURED_CLICK_METRIC = "featured_click" as const;
export type FeaturedClickMetric = typeof FEATURED_CLICK_METRIC;

/** A page carries at most three featured cards; a click is one of them. */
export const MAX_BEACON_FEATURED_CLICKS = 3;

export const FEATURED_CLICK_KEY_PREFIX = "fclick:";

/** `fclick:<spotId>:<listingId>:<YYYY-MM-DD>`. */
export function featuredClickKey(spotId: string, listingId: string, day: string): string {
  return `${FEATURED_CLICK_KEY_PREFIX}${spotId}:${listingId}:${day}`;
}

export interface ParsedFeaturedClickKey {
  spotId: string;
  listingId: string;
  day: string;
}

export function parseFeaturedClickKey(key: string): ParsedFeaturedClickKey | null {
  if (!key.startsWith(FEATURED_CLICK_KEY_PREFIX)) return null;
  const parts = key.slice(FEATURED_CLICK_KEY_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const [spotId, listingId, day] = parts;
  if (!isUuid(spotId) || !isUuid(listingId) || !isDayKey(day)) return null;
  return { spotId, listingId, day };
}
