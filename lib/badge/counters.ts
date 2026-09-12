import { createClient, type RedisClientType } from "@redis/client";
import type { BadgeCounterDelta } from "@/lib/db/queries/badges";

/**
 * Badge impressions and clicks, counted in Redis and written to Postgres by
 * the worker.
 *
 * A badge is embedded on someone else's website and served to every visitor of
 * it. One UPDATE per impression would mean a write — and a row lock on the
 * listing's badge — on every page view of every site that ever pasted the
 * snippet, which is the one traffic shape this application does not control.
 * Two Redis hashes absorb that at a few microseconds each, and the worker
 * folds them into the table once a minute.
 *
 * The counts are approximate by construction: Redis is not persisted here, so
 * a Redis restart loses at most a minute of them. That is the right trade for
 * a vanity metric on an owner dashboard. Nothing is billed on these numbers.
 */

export const IMPRESSION_HASH = "badge:impressions";
export const CLICK_HASH = "badge:clicks";

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType | null> | null = null;

/** Same shape as lib/spam/rate-limit.ts: stop asking a refused Redis for a bit. */
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

/** Test-only: drops the cached handle so the next call reads REDIS_URL again. */
export async function closeBadgeCounters(): Promise<void> {
  const c = client;
  client = null;
  redisDownUntil = 0;
  if (c) await c.quit().catch(() => {});
}

async function bump(hash: string, listingId: string): Promise<void> {
  // Never throws. The badge image and the click redirect both have to work
  // when the cache does not; a lost count is not worth a 500 on someone
  // else's website.
  try {
    const c = await redis();
    if (!c) return;
    await c.hIncrBy(hash, listingId, 1);
  } catch {
    /* counted or not, the response goes out */
  }
}

export async function recordBadgeImpression(listingId: string): Promise<void> {
  await bump(IMPRESSION_HASH, listingId);
}

export async function recordBadgeClick(listingId: string): Promise<void> {
  await bump(CLICK_HASH, listingId);
}

/**
 * How long an orphaned flush key is allowed to sit in Redis.
 *
 * The `del` in the `finally` is the normal cleanup and handles a thrown read.
 * It does not handle the worker being killed between the RENAME and the DEL —
 * nothing runs, and the counts sit in a key with a pid and a timestamp in its
 * name that nobody will ever look for again. Ten minutes is far longer than a
 * flush (which runs every minute) and short enough that a crash loop cannot
 * accumulate them.
 */
export const FLUSH_TEMP_TTL_MS = 600_000;

/**
 * Takes the pending counts and leaves the hashes empty.
 *
 * RENAME then read, rather than HGETALL then DEL: between those two commands
 * every impression that arrives is counted and then deleted unread. Renaming
 * is atomic, so a hit landing mid-flush starts a fresh hash instead of
 * vanishing. RENAME on a missing key is an error, which is simply "nothing
 * happened this minute".
 *
 * Exported for its own tests — a fake client is the only way to assert the
 * command ORDER, and the order is the whole point.
 */
export async function drainHash(
  c: RedisClientType,
  hash: string,
): Promise<Record<string, string>> {
  const temp = `${hash}:flush:${process.pid}:${Date.now()}`;
  try {
    await c.rename(hash, temp);
  } catch {
    return {};
  }
  // Before the read, not after: the window this covers is the one where we do
  // not get to run any more code.
  await c.pExpire(temp, FLUSH_TEMP_TTL_MS).catch(() => {});
  try {
    return await c.hGetAll(temp);
  } finally {
    await c.del(temp).catch(() => {});
  }
}

export async function drainBadgeCounters(): Promise<BadgeCounterDelta[]> {
  let impressions: Record<string, string> = {};
  let clicks: Record<string, string> = {};
  try {
    const c = await redis();
    if (!c) return [];
    impressions = await drainHash(c, IMPRESSION_HASH);
    clicks = await drainHash(c, CLICK_HASH);
  } catch {
    return [];
  }

  const merged = new Map<string, BadgeCounterDelta>();
  const add = (listingId: string, field: "impressions" | "clicks", raw: string): void => {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) return;
    const entry = merged.get(listingId) ?? { listingId, impressions: 0, clicks: 0 };
    entry[field] += value;
    merged.set(listingId, entry);
  };

  for (const [id, raw] of Object.entries(impressions)) add(id, "impressions", raw);
  for (const [id, raw] of Object.entries(clicks)) add(id, "clicks", raw);
  return [...merged.values()];
}
