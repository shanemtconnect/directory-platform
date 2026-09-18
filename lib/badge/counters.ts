import type { RedisClientType } from "@redis/client";
import type { BadgeCounterDelta } from "@/lib/db/queries/badges";
import { closeRedis, getRedis } from "@/lib/redis/client";
import { CounterBuffer } from "@/lib/redis/buffer";

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

/**
 * Hits that could not reach Redis, keyed `hash\0listingId`, written the next
 * time the shared client is available. A badge is served from someone else's
 * site at whatever rate that site gets traffic; a thirty-second Redis blip
 * used to drop every impression in it. Now it delays them.
 */
const pending = new CounterBuffer("badge");
const SEPARATOR = "\0";

function pendingKey(hash: string, listingId: string): string {
  return `${hash}${SEPARATOR}${listingId}`;
}

async function writePending(c: RedisClientType): Promise<void> {
  await pending.flush(async ({ key, count }) => {
    const at = key.indexOf(SEPARATOR);
    await c.hIncrBy(key.slice(0, at), key.slice(at + 1), count);
  });
}

/**
 * The shared client, with anything held while it was away written first.
 *
 * Null while a connect is in flight or Redis is cooling down — see
 * `lib/redis/client.ts` — in which case the caller holds its hit in `pending`.
 */
async function redis(): Promise<RedisClientType | null> {
  const c = await getRedis();
  if (c && pending.size > 0) await writePending(c);
  return c;
}

/** Test-only: drops the shared handle so the next call reads REDIS_URL again. */
export async function closeBadgeCounters(): Promise<void> {
  await closeRedis();
}

async function bump(hash: string, listingId: string): Promise<void> {
  // Never throws. The badge image and the click redirect both have to work
  // when the cache does not; a held count is not worth a 500 on someone
  // else's website.
  try {
    const c = await redis();
    if (!c) {
      // Nothing was sent: hold it.
      pending.add(pendingKey(hash, listingId));
      return;
    }
    await c.hIncrBy(hash, listingId, 1);
  } catch {
    // The write was sent and rejected; it may have landed before the socket
    // died. Not held — a lost hit beats a doubled one (`lib/redis/buffer.ts`
    // header). Counted or not, the response goes out.
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
    if (!c) throw new Error("[badge] Redis is unreachable");
    impressions = await drainHash(c, IMPRESSION_HASH);
    clicks = await drainHash(c, CLICK_HASH);
  } catch {
    // Not an error for the job — the hits are held in the web processes and
    // the health probe reports the outage — but not silence either.
    console.warn("[badge] drain skipped: Redis unreachable");
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
