import { createClient, type RedisClientType } from "@redis/client";

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType | null> | null = null;

/**
 * When Redis refuses a connection, stop asking for a bit.
 *
 * Retrying on every call costs a connect timeout per submit, which turns one
 * dead cache into a form that appears to hang.
 */
const REDIS_RETRY_COOLDOWN_MS = 30_000;
let redisDownUntil = 0;

async function redis(): Promise<RedisClientType | null> {
  if (client?.isReady) return client;
  if (Date.now() < redisDownUntil) return null;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const c = createClient({
        url: process.env.REDIS_URL,
        socket: { connectTimeout: 3000, reconnectStrategy: (n) => (n > 3 ? false : 200 * n) },
      }) as RedisClientType;
      c.on("error", () => {});
      await c.connect();
      client = c;
      redisDownUntil = 0;
      return c;
    } catch {
      redisDownUntil = Date.now() + REDIS_RETRY_COOLDOWN_MS;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * The fallback counter, used only while Redis is unreachable.
 *
 * Per process, so behind several instances it lets through a multiple of the
 * limit. That is the point: it is a floor, not a replacement. Failing OPEN —
 * what this used to do — turns a cache outage into an unmetered public write
 * endpoint, which is a far more expensive mistake than an over-generous cap
 * during an outage.
 */
const memory = new Map<string, { count: number; expiresAt: number }>();

function memoryLimit(
  redisKey: string,
  opts: { limit: number; windowSeconds: number },
  secondsLeft: number,
): RateLimitResult {
  // Sweeping on write is what stands in for Redis's EXPIRE. Without it the map
  // grows by one entry per distinct IP for the life of the process.
  const now = Date.now();
  for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);

  const entry = memory.get(redisKey) ?? { count: 0, expiresAt: now + secondsLeft * 1000 };
  entry.count += 1;
  memory.set(redisKey, entry);

  return {
    allowed: entry.count <= opts.limit,
    remaining: Math.max(0, opts.limit - entry.count),
    retryAfterSeconds: secondsLeft,
  };
}

/** Fixed-window counter in Redis, with an in-process counter behind it. */
export async function rateLimit(
  key: string,
  opts: { limit: number; windowSeconds: number },
): Promise<RateLimitResult> {
  const nowSeconds = Date.now() / 1000;
  const bucket = Math.floor(nowSeconds / opts.windowSeconds);
  const redisKey = `ratelimit:${key}:${bucket}`;
  const secondsLeft = Math.max(1, Math.ceil((bucket + 1) * opts.windowSeconds - nowSeconds));

  const c = await redis();
  if (!c) return memoryLimit(redisKey, opts, secondsLeft);

  try {
    const count = await c.incr(redisKey);
    if (count === 1) await c.expire(redisKey, opts.windowSeconds);
    const ttl = await c.ttl(redisKey);
    return {
      allowed: count <= opts.limit,
      remaining: Math.max(0, opts.limit - count),
      retryAfterSeconds: ttl > 0 ? ttl : secondsLeft,
    };
  } catch {
    return memoryLimit(redisKey, opts, secondsLeft);
  }
}
