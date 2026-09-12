import { createClient, type RedisClientType } from "@redis/client";

/**
 * The stats pipeline's Redis handle.
 *
 * Separate from `lib/spam/rate-limit.ts`'s handle on purpose, even though the
 * two connect to the same server with the same care: they have different
 * lifetimes (one lives in a worker process on a cron, one on the request path)
 * and different failure meanings (a lost counter is a lost view; a lost rate
 * limit is an open endpoint). Sharing a module-level client between them would
 * make one module's cooldown the other's outage.
 *
 * The exported surface is a narrow interface rather than the node-redis client
 * so the rest of `lib/stats` cannot reach for DEL, FLUSHALL or KEYS by
 * accident — this runs against the same Redis that serves the page cache.
 */

/** Short: this is called from a request handler, behind a `no-store` beacon. */
const CONNECT_TIMEOUT_MS = 1500;

/**
 * When Redis refuses a connection, stop asking for a bit.
 *
 * Same reasoning as the rate limiter's: retrying per call turns one dead cache
 * into a connect timeout on every page view.
 */
const RETRY_COOLDOWN_MS = 30_000;

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

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType | null> | null = null;
let downUntil = 0;

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
    scan: async (cursor, match, count) => {
      const reply = await c.scan(cursor, { MATCH: match, COUNT: count });
      // node-redis v4 replied with a numeric cursor, v6 with a string — the
      // same shape-tolerance `lib/cache/sweep.mjs` carries, for the same reason.
      const raw = reply as unknown as { cursor?: unknown; keys?: string[] } | [unknown, string[]];
      if (Array.isArray(raw)) return { cursor: String(raw[0]), keys: raw[1] ?? [] };
      return { cursor: String(raw.cursor), keys: raw.keys ?? [] };
    },
    takeAll: async (keys) => {
      const values = await Promise.all(keys.map((k) => c.getDel(k)));
      const out = new Map<string, number>();
      keys.forEach((key, i) => {
        const n = Number(values[i]);
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

/**
 * A connected client, or null when there is no Redis to talk to.
 *
 * Null rather than a throw: every caller in this module is fire-and-forget,
 * and REDIS_URL being unset is a legitimate state in a unit test run. In
 * production it is required at boot (`config/validate.ts` RUNTIME_ENV), so a
 * null here means the cache is genuinely down, not misconfigured.
 */
export async function statsRedis(): Promise<StatsRedisClient | null> {
  if (process.env.NEXT_PHASE === PRODUCTION_BUILD_PHASE) return null;
  if (!process.env.REDIS_URL) return null;
  if (client?.isReady) return wrap(client);
  if (Date.now() < downUntil) return null;
  if (connecting) {
    const existing = await connecting;
    return existing ? wrap(existing) : null;
  }

  connecting = (async () => {
    try {
      const c = createClient({
        url: process.env.REDIS_URL,
        socket: {
          connectTimeout: CONNECT_TIMEOUT_MS,
          reconnectStrategy: (n) => (n > 3 ? false : 200 * n),
        },
      }) as RedisClientType;
      // Swallowed: an unhandled 'error' event takes the process down, and a
      // cache blip must not stop the site or the worker.
      c.on("error", () => {});
      await c.connect();
      client = c;
      downUntil = 0;
      return c;
    } catch {
      downUntil = Date.now() + RETRY_COOLDOWN_MS;
      return null;
    } finally {
      connecting = null;
    }
  })();

  const connected = await connecting;
  return connected ? wrap(connected) : null;
}

/** Test-only, and the worker's shutdown path. Also clears the cooldown. */
export async function closeStatsRedis(): Promise<void> {
  const c = client;
  client = null;
  downUntil = 0;
  if (!c) return;
  try {
    await c.quit();
  } catch {
    // Already gone; nothing to close.
  }
}
