import { now } from "@/lib/clock";
import { statsRedis } from "./redis";
import {
  STATS_KEY_PREFIX,
  type StatMetric,
  dayKey,
  isStatMetric,
  isUuid,
  parseStatsKey,
  seenKey,
  statsKey,
} from "./keys";

/**
 * The counters themselves.
 *
 * A page view must never cost a database write. At 200 listings and a modest
 * crawl budget that is already thousands of row updates an hour, all of them
 * contending on the same `listing_stats_daily` row — and the number they
 * produce is only ever read once a day by one person. So every hit is an INCR
 * in Redis and the worker folds them into the table every five minutes.
 *
 * Everything here is fire-and-forget: no function throws, and losing a count
 * is always preferable to failing the request that produced it.
 */

/**
 * Seven days.
 *
 * The flush runs every five minutes, so a counter that survives this long
 * means the worker has been dead for a week — at which point the counts are
 * long past useful and what matters is that Redis is not carrying a key per
 * listing per day for ever. Long enough that an afternoon's outage loses
 * nothing; short enough to be self-cleaning.
 */
export const COUNTER_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * One day. A per-address mark exists so one address counts one view of one
 * listing per day; keeping it longer would refuse tomorrow's genuine visit.
 */
export const SEEN_TTL_SECONDS = 24 * 60 * 60;

/**
 * The salt `seenKey` hashes an address under.
 *
 * `STATS_SEEN_SALT` when set, otherwise `BETTER_AUTH_SECRET` — which every
 * running site already has (`config/validate.ts` requires it at boot), is
 * generated the same way, and is exactly as secret as this needs to be. The
 * dedicated variable exists so a site can rotate one without the other.
 * Read per call rather than at import, so a test can change it; the cost is
 * two property lookups on a path that is about to do a Redis round trip.
 *
 * Empty when neither is set (a unit test, `next dev` with no auth configured).
 * The digest is still a digest — Redis still never holds an address — it just
 * has no protection against a precomputed table, which is the trade for not
 * making `next dev` refuse to count a view.
 */
export function seenSalt(): string {
  return process.env.STATS_SEEN_SALT || process.env.BETTER_AUTH_SECRET || "";
}

export interface StatEvent {
  listingId: string;
  metric: StatMetric;
}

/** One listing's counts for one day, as the flush hands them to the database. */
export interface StatDelta {
  listingId: string;
  day: string;
  views: number;
  impressions: number;
  enquiries: number;
  shortlistAdds: number;
  badgeClicks: number;
}

function emptyDelta(listingId: string, day: string): StatDelta {
  return {
    listingId, day,
    views: 0, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0,
  };
}

function add(delta: StatDelta, metric: StatMetric, n: number): void {
  switch (metric) {
    case "view": delta.views += n; break;
    case "impression": delta.impressions += n; break;
    case "enquiry": delta.enquiries += n; break;
    case "shortlist_add": delta.shortlistAdds += n; break;
    case "badge_click": delta.badgeClicks += n; break;
  }
}

/**
 * Count one event.
 *
 * @returns whether it landed. False means the id was rejected or Redis was
 *   unreachable — never a reason to fail the caller.
 */
export async function recordStat(
  listingId: string,
  metric: StatMetric,
  at: Date = now(),
): Promise<boolean> {
  return (await recordStats([{ listingId, metric }], at)) > 0;
}

/**
 * Count a batch. One page's worth of impressions arrives as a single beacon,
 * so a batch is the normal case rather than the optimisation.
 *
 * Validates every id here rather than trusting the caller: the batch comes
 * straight off a public request body, and an unvalidated id is a key anyone on
 * the internet can name.
 */
export async function recordStats(events: StatEvent[], at: Date = now()): Promise<number> {
  const valid = events.filter((e) => isUuid(e.listingId) && isStatMetric(e.metric));
  if (valid.length === 0) return 0;

  const client = await statsRedis();
  if (!client) return 0;

  const day = dayKey(at);
  let landed = 0;
  await Promise.all(
    valid.map(async (e) => {
      try {
        const key = statsKey(e.listingId, day, e.metric);
        const count = await client.incr(key);
        // Only the first writer pays for the EXPIRE, exactly as the rate
        // limiter does — the TTL is per key, not per increment.
        if (count === 1) await client.expire(key, COUNTER_TTL_SECONDS);
        landed += 1;
      } catch {
        // Redis went away mid-batch. The view is lost; the request is not.
      }
    }),
  );
  return landed;
}

/**
 * Whether this address's view of this listing is the first today.
 *
 * SET NX EX in one round trip: the first caller creates the mark and is told
 * so; every later one the same day is told no. The beacon drops the view on a
 * no and still counts the impressions — a person reloading a page is one
 * visitor, and so is a script posting the same beacon a thousand times.
 *
 * True, not false, when Redis is unreachable or the id is refused by Redis:
 * the guard protects a counter that cannot be written either, and the
 * caller's own validation has already thrown out a bad id. A non-uuid here is
 * the one exception, refused outright so it can never become a key.
 */
export async function claimDailyView(
  ip: string,
  listingId: string,
  at: Date = now(),
): Promise<boolean> {
  if (!isUuid(listingId)) return false;
  const client = await statsRedis();
  if (!client) return true;
  try {
    return await client.setIfAbsent(
      seenKey(dayKey(at), ip, listingId, seenSalt()),
      "1",
      SEEN_TTL_SECONDS,
    );
  } catch {
    return true;
  }
}

export interface DrainOptions {
  /** Keys taken per pipelined GETDEL round. */
  batchSize?: number;
  /** SCAN COUNT hint. */
  scanCount?: number;
}

/**
 * Take every counter out of Redis and fold it into per-listing, per-day deltas.
 *
 * SCAN, never KEYS: this runs against the same Redis that holds the page
 * cache, and KEYS blocks the server for the length of the keyspace.
 *
 * GETDEL, never GET-then-DEL: an INCR landing between the two would be counted
 * and then deleted. GETDEL is atomic, so a hit arriving mid-flush starts a
 * fresh counter that the next flush picks up — the test "leaves counters
 * written after the drain started for the next flush" is that guarantee.
 *
 * The deltas are additive, so the worst case if the database write fails after
 * the drain is one flush's counts lost. That is the deliberate trade against
 * the alternative — leaving the keys until the write succeeds, which
 * double-counts whenever the write succeeded but the acknowledgement did not.
 */
export async function drainStats(opts: DrainOptions = {}): Promise<StatDelta[]> {
  const { batchSize = 256, scanCount = 500 } = opts;
  const client = await statsRedis();
  if (!client) return [];

  const deltas = new Map<string, StatDelta>();

  const take = async (keys: string[]): Promise<void> => {
    const values = await client.takeAll(keys);
    for (const [key, count] of values) {
      const parsed = parseStatsKey(key);
      // Already refused by the SCAN filter below; belt and braces, because
      // this is the last gate before a database write.
      if (!parsed) continue;
      const id = `${parsed.listingId}:${parsed.day}`;
      let delta = deltas.get(id);
      if (!delta) {
        delta = emptyDelta(parsed.listingId, parsed.day);
        deltas.set(id, delta);
      }
      add(delta, parsed.metric, count);
    }
  };

  let cursor = "0";
  let batch: string[] = [];
  const seen = new Set<string>();
  try {
    do {
      const page = await client.scan(cursor, `${STATS_KEY_PREFIX}*`, scanCount);
      cursor = page.cursor;
      for (const key of page.keys) {
        // SCAN may return the same key twice. GETDEL would make the repeat a
        // no-op anyway; skipping it saves the round trip.
        if (seen.has(key)) continue;
        seen.add(key);
        // A key nobody in this codebase wrote must not become a database row.
        if (!parseStatsKey(key)) continue;
        batch.push(key);
      }
      if (batch.length >= batchSize) {
        await take(batch);
        batch = [];
      }
    } while (cursor !== "0");

    if (batch.length > 0) await take(batch);
  } catch {
    // Redis died mid-drain. Return whatever was already taken — those counts
    // are out of Redis and only this return value can still record them.
  }

  return [...deltas.values()];
}
