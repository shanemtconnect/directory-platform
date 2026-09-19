import type { RedisClientType } from "@redis/client";
import { CounterBuffer } from "@/lib/redis/buffer";
import { closeRedis, getRedis } from "@/lib/redis/client";

/**
 * The stats pipeline's view of Redis.
 *
 * The connection itself is the process-wide one in `lib/redis/client.ts`,
 * shared with the rate limiter and the badge counters. That client hands out
 * null while a connect is in flight or Redis is in its down-cooldown, and
 * this module's answer to null is to HOLD a count rather than drop it: an
 * INCR that cannot reach Redis goes into a bounded in-process buffer and is
 * written the next time a client is available. A view during a Redis blip
 * is delayed, not lost. (Sharing a client used to mean sharing a cooldown,
 * which was the argument for a separate handle here; with the buffer, a
 * cooldown is no longer an outage for the counters.)
 *
 * The exported surface is a narrow interface rather than the node-redis client
 * so the rest of `lib/stats` cannot reach for DEL, FLUSHALL or KEYS by
 * accident — this runs against the same Redis that serves the page cache.
 */

export interface ScanPage {
  cursor: string;
  keys: string[];
}

export interface StatsRedisClient {
  /** INCR, returning the new value. */
  incr(key: string): Promise<number>;
  /** EXPIRE, seconds. */
  expire(key: string, seconds: number): Promise<void>;
  /** TTL in seconds; negative when the key has none or is gone. */
  ttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /**
   * SET NX EX: writes the key only if it is absent, with a TTL, atomically.
   * True when this call created it — the one caller that may act on it.
   * While Redis is away the first sight of a key in this process is true and
   * every repeat is false, from an in-memory set (see `seenWhileAway`): the
   * mark guards a counter that is being held rather than written, and a held
   * view beats a dropped one — but a reload loop during the outage must not
   * hold one view per post.
   */
  setIfAbsent(key: string, value: string, seconds: number): Promise<boolean>;
  /** One SCAN page. Never KEYS — this server also holds the page cache. */
  scan(cursor: string, match: string, count: number): Promise<ScanPage>;
  /**
   * GETDEL each key, pipelined. Atomic per key, which is what makes the flush
   * safe: an INCR that lands between the read and the write of a key would be
   * lost by a GET-then-DEL, and starts a fresh counter here instead.
   */
  takeAll(keys: string[]): Promise<Map<string, number>>;
  /** Test-only. Database 7 in this worktree; never FLUSHALL. */
  flushDb(): Promise<void>;
}

/**
 * Only `incr` and `expire` are answered from the buffer while Redis is away.
 * Every other command rejects: a SCAN that answered with an empty page would
 * tell a drain there was nothing to flush, and a GET would report a count of
 * nothing. The callers already treat a rejection as "not now".
 *
 * "Away" means the shared client was null — nothing was sent. An INCR that
 * reaches a ready client and rejects is NOT held: the server may have applied
 * it before the socket died, and a lost view beats a doubled one
 * (`lib/redis/buffer.ts` header, `worker/jobs/flush-stats.ts`). It throws to
 * the caller, which drops it, exactly as before this buffer existed.
 */

/** Counts that could not reach Redis, written the next time a client can. */
const pending = new CounterBuffer("stats");

/** Same order of magnitude as the counter buffer's cap; one string per entry. */
export const SEEN_WHILE_AWAY_MAX_KEYS = 10_000;

/**
 * Keys `setIfAbsent` has said yes to while the shared client was null.
 *
 * Stands in for the SET NX mark for this process only: repeats within the
 * process are refused, repeats across processes (and a repeat after Redis is
 * back, when this set is cleared and Redis is the authority again) are the
 * bounded case — at most one extra held view per listing per web process per
 * outage, inside BEACON_RATE_LIMIT. Bounded like the buffer: past the cap the
 * oldest is evicted, and the set is dropped whole on a day change, since
 * every key carries the day and yesterday's entries can never match again.
 */
const seenWhileAway = new Set<string>();
let seenWhileAwayDay = "";

function seenWhileAwayAdd(key: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== seenWhileAwayDay) {
    seenWhileAway.clear();
    seenWhileAwayDay = today;
  }
  if (seenWhileAway.has(key)) return false;
  if (seenWhileAway.size >= SEEN_WHILE_AWAY_MAX_KEYS) {
    const oldest = seenWhileAway.values().next().value;
    if (oldest !== undefined) seenWhileAway.delete(oldest);
  }
  seenWhileAway.add(key);
  return true;
}

/** Next sets this during `next build`; constraint 4 says never connect then. */
const PRODUCTION_BUILD_PHASE = "phase-production-build";

function wrap(c: RedisClientType): StatsRedisClient {
  return {
    incr: (key) => c.incr(key),
    expire: async (key, seconds) => {
      await c.expire(key, seconds);
    },
    ttl: (key) => c.ttl(key),
    get: (key) => c.get(key) as Promise<string | null>,
    set: async (key, value) => {
      await c.set(key, value);
    },
    setIfAbsent: async (key, value, seconds) => {
      const reply = await c.set(key, value, { NX: true, EX: seconds });
      return reply === "OK";
    },
    scan: async (cursor, match, count) => {
      const reply = await c.scan(cursor, { MATCH: match, COUNT: count });
      // node-redis v4 replied with a numeric cursor, v6 with a string — the
      // same shape-tolerance `lib/cache/sweep.mjs` carries, for the same reason.
      const raw = reply as unknown as { cursor?: unknown; keys?: string[] } | [unknown, string[]];
      if (Array.isArray(raw)) return { cursor: String(raw[0]), keys: raw[1] ?? [] };
      return { cursor: String(raw.cursor), keys: raw.keys ?? [] };
    },
    takeAll: async (keys) => {
      // `allSettled`, not `all`: one GETDEL that rejects (a key SCAN handed us
      // that something else already deleted and replaced, say) must not throw
      // the whole pipeline away. The keys before and after it in the batch
      // have already been taken out of Redis by the time any of this
      // resolves — `all`'s reject-on-first-rejection would still lose those
      // counts even though GETDEL itself deleted them.
      const results = await Promise.allSettled(keys.map((k) => c.getDel(k)));
      const out = new Map<string, number>();
      keys.forEach((key, i) => {
        const result = results[i]!;
        if (result.status !== "fulfilled") return;
        const n = Number(result.value);
        // A key that vanished between SCAN and GETDEL (expired, or taken by
        // another flusher) reads as null; a non-numeric one was not ours.
        if (Number.isSafeInteger(n) && n > 0) out.set(key, n);
      });
      return out;
    },
    flushDb: async () => {
      await c.flushDb();
    },
  };
}

async function writePending(c: RedisClientType): Promise<void> {
  await pending.flush(async ({ key, count, expireSeconds }) => {
    const total = await c.incrBy(key, count);
    // The key was fresh in Redis if the reply is exactly what we added: apply
    // the TTL the caller asked for. Anything larger means another writer got
    // there first, and the key has its TTL from them.
    if (expireSeconds !== null && total === count) await c.expire(key, expireSeconds);
  });
}

/**
 * The shared client, with anything held while it was away written first,
 * or null while it is still away (see `lib/redis/client.ts`).
 */
async function live(): Promise<RedisClientType | null> {
  const c = await getRedis();
  if (c) {
    // Redis is the authority again; the in-process marks have done their job.
    if (seenWhileAway.size > 0) seenWhileAway.clear();
    if (pending.size > 0) await writePending(c);
  }
  return c;
}

async function connected(): Promise<RedisClientType> {
  const c = await live();
  if (!c) throw new Error("[stats] Redis is unreachable");
  return c;
}

const stats: StatsRedisClient = {
  incr: async (key) => {
    const c = await live();
    if (!c) return pending.add(key);
    // A throw here propagates: the write was sent and may have landed.
    return c.incr(key);
  },
  expire: async (key, seconds) => {
    const c = await live();
    if (!c) {
      pending.expire(key, seconds);
      return;
    }
    await c.expire(key, seconds);
  },
  ttl: async (key) => wrap(await connected()).ttl(key),
  get: async (key) => wrap(await connected()).get(key),
  set: async (key, value) => wrap(await connected()).set(key, value),
  setIfAbsent: async (key, value, seconds) => {
    const c = await live();
    if (!c) return seenWhileAwayAdd(key);
    return wrap(c).setIfAbsent(key, value, seconds);
  },
  scan: async (cursor, match, count) => wrap(await connected()).scan(cursor, match, count),
  takeAll: async (keys) => wrap(await connected()).takeAll(keys),
  flushDb: async () => wrap(await connected()).flushDb(),
};

/**
 * The stats client, or null when there is no Redis to talk to at all.
 *
 * Null only when REDIS_URL is unset or this is `next build`: REDIS_URL being
 * unset is a legitimate state in a unit test run, and in production it is
 * required at boot (`config/validate.ts` RUNTIME_ENV). A Redis that is
 * configured but unreachable is NOT null — it is a client that holds counts
 * until Redis is back, and every caller in this module is fire-and-forget.
 * Nothing is connected by this call; the first command does that.
 */
export async function statsRedis(): Promise<StatsRedisClient | null> {
  if (process.env.NEXT_PHASE === PRODUCTION_BUILD_PHASE) return null;
  if (!process.env.REDIS_URL) return null;
  return stats;
}

/**
 * Test-only, and a worker's shutdown path. This is `closeRedis()`: it drops
 * the SHARED handle and clears the cooldown, and takes the rate limiter's and
 * the badge counters' handle with it — they are the same one. Counts held in
 * the buffer stay held: they are written on the next available client, not
 * on close.
 */
export async function closeStatsRedis(): Promise<void> {
  await closeRedis();
}
