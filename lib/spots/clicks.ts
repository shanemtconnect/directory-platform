import { now } from "@/lib/clock";
import { COUNTER_TTL_SECONDS } from "@/lib/stats/counters";
import { dayKey, isUuid } from "@/lib/stats/keys";
import { statsRedis } from "@/lib/stats/redis";
import { FEATURED_CLICK_KEY_PREFIX, featuredClickKey, parseFeaturedClickKey } from "./click-keys";

/**
 * Clicks on a featured card (Task 45, requirement 4): the number the owner
 * sees beside each position they hold.
 *
 * Same shape as `lib/ads/counters` and for the same reasons: the pillar page
 * is ISR-cached, so the click is counted from the browser through
 * `/api/beacon`, lands as one INCR in Redis, and the worker turns five
 * minutes of them into rows of `featured_clicks_daily`. Its own key prefix
 * so neither of the other drains can see these keys. No address, no cookie,
 * no identifier: a spot id, a listing id and a date. The key vocabulary is
 * in ./click-keys.ts so the page tree never imports this Redis-bearing file.
 */

export {
  FEATURED_CLICK_KEY_PREFIX,
  FEATURED_CLICK_METRIC,
  MAX_BEACON_FEATURED_CLICKS,
  featuredClickKey,
  parseFeaturedClickKey,
  type FeaturedClickMetric,
  type ParsedFeaturedClickKey,
} from "./click-keys";

export interface FeaturedClickEvent {
  spotId: string;
  listingId: string;
}

export async function recordFeaturedClicks(
  events: readonly FeaturedClickEvent[],
  at: Date = now(),
): Promise<number> {
  const valid = events.filter((e) => isUuid(e.spotId) && isUuid(e.listingId));
  if (valid.length === 0) return 0;
  const client = await statsRedis();
  if (!client) return 0;
  const day = dayKey(at);
  let landed = 0;
  await Promise.all(
    valid.map(async (e) => {
      try {
        const key = featuredClickKey(e.spotId.toLowerCase(), e.listingId.toLowerCase(), day);
        const count = await client.incr(key);
        if (count === 1) await client.expire(key, COUNTER_TTL_SECONDS);
        landed += 1;
      } catch {
        // Redis went away mid-batch. The click is lost; the request is not.
      }
    }),
  );
  return landed;
}

export interface FeaturedClickDelta {
  readonly spotId: string;
  readonly listingId: string;
  readonly day: string;
  readonly clicks: number;
}

export async function drainFeaturedClicks(
  opts: { batchSize?: number; scanCount?: number } = {},
): Promise<FeaturedClickDelta[]> {
  const { batchSize = 256, scanCount = 500 } = opts;
  const client = await statsRedis();
  if (!client) return [];
  const deltas: FeaturedClickDelta[] = [];
  const take = async (keys: string[]): Promise<void> => {
    const values = await client.takeAll(keys);
    for (const [key, count] of values) {
      const parsed = parseFeaturedClickKey(key);
      if (!parsed || count <= 0) continue;
      deltas.push({ ...parsed, clicks: count });
    }
  };
  let cursor = "0";
  let batch: string[] = [];
  const seen = new Set<string>();
  try {
    do {
      const page = await client.scan(cursor, `${FEATURED_CLICK_KEY_PREFIX}*`, scanCount);
      cursor = page.cursor;
      for (const key of page.keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (!parseFeaturedClickKey(key)) continue;
        batch.push(key);
      }
      if (batch.length >= batchSize) {
        await take(batch);
        batch = [];
      }
    } while (cursor !== "0");
    if (batch.length > 0) await take(batch);
  } catch {
    console.warn("[spots] featured click drain skipped: Redis unreachable");
  }
  return deltas;
}
