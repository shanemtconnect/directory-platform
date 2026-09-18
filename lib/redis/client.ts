import { createClient, type RedisClientType } from "@redis/client";

/**
 * The one Redis client this process holds.
 *
 * Shared by the rate limiter (`lib/spam/rate-limit.ts`), the view counters
 * (`lib/stats/redis.ts`) and the badge counters (`lib/badge/counters.ts`),
 * which until this module each kept a copy of the same connect / cooldown /
 * in-flight logic and three sockets to the same server. Not by the health
 * probe (`lib/observability/redis.ts`), which explains why itself.
 *
 * The contract every caller is written against:
 *
 * - A ready client is returned as is.
 * - When Redis last refused a connection, null is returned for the next
 *   thirty seconds without trying again. Retrying on every call costs a
 *   connect timeout per request, which turns one dead cache into a site
 *   that appears to hang.
 * - Only the call that STARTS a connect attempt waits for its answer. Every
 *   call that arrives while it is pending gets null at once. A connect can
 *   take the full timeout times the reconnect attempts, and the cooldown
 *   only spares the calls after it; without this, every request in that
 *   window would queue behind it. The initiator still waits so that the cold
 *   start — and the first call after a cooldown — lands on Redis.
 *
 * What a caller does with null is its own business: the rate limiter counts
 * in process, the counters buffer and flush later. Sharing the client means
 * sharing the cooldown too. That used to be an argument for separate handles
 * (one module's cooldown was another's dropped counts); now that null is a
 * delay for the counters rather than a loss, it is not.
 *
 * Never connects during `next build` (constraint 4), and never without a
 * REDIS_URL: the default would be localhost:6379, which is never where this
 * application's Redis is.
 */

export type RedisClient = RedisClientType;

export const REDIS_RETRY_COOLDOWN_MS = 30_000;

/**
 * Only the initiating caller ever pays this, once per attempt; everyone else
 * is answered at once. The stats module used to run a shorter 1.5 s on the
 * grounds that it sat behind a beacon — but so does the rate limiter, and
 * a false "down" verdict now costs thirty seconds of buffering for every
 * counter in the process, which is dearer than a slow first hit.
 */
const CONNECT_TIMEOUT_MS = 3000;

/** Next sets this during `next build`. */
const PRODUCTION_BUILD_PHASE = "phase-production-build";

let client: RedisClient | null = null;
let connecting: Promise<RedisClient | null> | null = null;
let downUntil = 0;

export type RedisStatus =
  /** No REDIS_URL, or `next build`: nothing will ever be connected. */
  | "unconfigured"
  /** Nothing open and nothing pending; the next call will connect. */
  | "disconnected"
  /** A connect is in flight; callers other than its initiator get null. */
  | "connecting"
  | "ready"
  /** The last connect was refused; callers get null until `downUntil`. */
  | "down";

export interface RedisState {
  status: RedisStatus;
  /** Epoch ms the cooldown ends, when `status` is "down". */
  downUntil: number | null;
}

function configured(): boolean {
  if (process.env.NEXT_PHASE === PRODUCTION_BUILD_PHASE) return false;
  return Boolean(process.env.REDIS_URL);
}

/** For tests and the health route. Same order of precedence as `getRedis`. */
export function redisState(): RedisState {
  if (!configured()) return { status: "unconfigured", downUntil: null };
  if (client?.isReady) return { status: "ready", downUntil: null };
  if (Date.now() < downUntil) return { status: "down", downUntil };
  if (connecting) return { status: "connecting", downUntil: null };
  return { status: "disconnected", downUntil: null };
}

function discard(c: RedisClient): void {
  try {
    c.destroy();
  } catch {
    // Destroying a socket that never opened, or that already closed, can
    // throw. Either way there is nothing left to hold.
  }
}

export async function getRedis(): Promise<RedisClient | null> {
  if (!configured()) return null;
  if (client?.isReady) return client;
  if (Date.now() < downUntil) return null;
  if (connecting) return null;

  connecting = (async () => {
    // A handle that is no longer ready is one node-redis has given up
    // reconnecting; it is replaced, not reused, and its socket goes with it.
    const stale = client;
    client = null;
    if (stale) discard(stale);

    const c = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: (n) => (n > 3 ? false : 200 * n) },
    }) as RedisClient;
    // Swallowed: an unhandled 'error' event takes the process down, and a
    // cache blip must not stop the site or the worker.
    c.on("error", () => {});
    try {
      await c.connect();
      client = c;
      downUntil = 0;
      return c;
    } catch {
      discard(c);
      downUntil = Date.now() + REDIS_RETRY_COOLDOWN_MS;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/**
 * Drops the handle and clears the cooldown, so the next call reads REDIS_URL
 * afresh and connects. For tests, and for a worker's shutdown path. Nothing
 * held in a counter buffer is written by this: the buffers belong to their
 * modules, and they flush on the next available client, not on close.
 */
export async function closeRedis(): Promise<void> {
  const c = client;
  client = null;
  downUntil = 0;
  if (!c) return;
  try {
    await c.close();
  } catch {
    // Already gone; nothing to close.
  }
}
