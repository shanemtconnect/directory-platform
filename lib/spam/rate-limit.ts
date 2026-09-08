import { createClient, type RedisClientType } from "@redis/client";

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType | null> | null = null;

async function redis(): Promise<RedisClientType | null> {
  if (client?.isReady) return client;
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
      return c;
    } catch {
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
 * Fixed-window counter in Redis.
 *
 * Fails OPEN when Redis is unreachable: a directory that stops accepting
 * enquiries because a cache is down has broken the thing it exists to do. Spam
 * is annoying; a silently dead contact form loses the listing owner money and
 * nobody notices for weeks.
 */
export async function rateLimit(
  key: string,
  opts: { limit: number; windowSeconds: number },
): Promise<RateLimitResult> {
  const c = await redis();
  if (!c) return { allowed: true, remaining: opts.limit, retryAfterSeconds: 0 };

  const bucket = Math.floor(Date.now() / 1000 / opts.windowSeconds);
  const redisKey = `ratelimit:${key}:${bucket}`;

  try {
    const count = await c.incr(redisKey);
    if (count === 1) await c.expire(redisKey, opts.windowSeconds);
    const ttl = await c.ttl(redisKey);
    return {
      allowed: count <= opts.limit,
      remaining: Math.max(0, opts.limit - count),
      retryAfterSeconds: ttl > 0 ? ttl : opts.windowSeconds,
    };
  } catch {
    return { allowed: true, remaining: opts.limit, retryAfterSeconds: 0 };
  }
}
