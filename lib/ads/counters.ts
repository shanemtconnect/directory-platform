import { now } from "@/lib/clock";
import { COUNTER_TTL_SECONDS, SEEN_TTL_SECONDS, seenSalt } from "@/lib/stats/counters";
import { dayKey, isUuid, seenSubject } from "@/lib/stats/keys";
import { statsRedis } from "@/lib/stats/redis";
import type { SponsorStatDelta } from "@/lib/db/queries/ads";
import {
  SPONSOR_KEY_PREFIX,
  isSponsorMetric,
  parseSponsorStatsKey,
  sponsorStatsKey,
  type SponsorMetric,
} from "./keys";

/**
 * Impressions and clicks per campaign per day, in Redis, drained by the
 * worker into `sponsor_stats_daily`. Same shape and the same guarantees as
 * `lib/stats/counters`: nothing on the request path writes to Postgres, a
 * counter key holds no personal data, GETDEL makes the drain atomic per key,
 * SCAN never KEYS, and an unflushed key expires on its own.
 */

export async function recordSponsorStat(
  campaignId: string,
  metric: SponsorMetric,
  at: Date = now(),
): Promise<boolean> {
  return (await recordSponsorStats([{ campaignId, metric }], at)) > 0;
}

export interface SponsorStatEvent {
  campaignId: string;
  metric: SponsorMetric;
}

export async function recordSponsorStats(
  events: readonly SponsorStatEvent[],
  at: Date = now(),
): Promise<number> {
  const valid = events.filter((e) => isUuid(e.campaignId) && isSponsorMetric(e.metric));
  if (valid.length === 0) return 0;
  const client = await statsRedis();
  if (!client) return 0;
  const day = dayKey(at);
  let landed = 0;
  await Promise.all(
    valid.map(async (e) => {
      try {
        const key = sponsorStatsKey(e.campaignId.toLowerCase(), day, e.metric);
        const count = await client.incr(key);
        if (count === 1) await client.expire(key, COUNTER_TTL_SECONDS);
        landed += 1;
      } catch {
        // Redis went away mid-batch. The impression is lost; the request is not.
      }
    }),
  );
  return landed;
}

/**
 * `sponsor:seen:<day>:<digest>:<campaignId>` — one click per address per
 * campaign per day (I5). The same salted `sha256(ip, day, salt)` as
 * `claimDailyView`: no raw address in Redis, a different string tomorrow,
 * gone after a day. Four parts after the prefix, so the drain's parser
 * refuses it as a count. True when this is the first click today, and true
 * when Redis is away (counting is the honest default).
 */
export function sponsorSeenKey(day: string, ip: string, campaignId: string, salt: string): string {
  return `${SPONSOR_KEY_PREFIX}seen:${day}:${seenSubject(ip, day, salt)}:${campaignId}`;
}

export async function claimDailyClick(ip: string, campaignId: string, at: Date = now()): Promise<boolean> {
  if (!isUuid(campaignId)) return false;
  const client = await statsRedis();
  if (!client) return true;
  try {
    return await client.setIfAbsent(
      sponsorSeenKey(dayKey(at), ip, campaignId.toLowerCase(), seenSalt()),
      "1",
      SEEN_TTL_SECONDS,
    );
  } catch {
    return true;
  }
}

export async function recordSponsorImpressions(
  campaignIds: readonly string[],
  at: Date = now(),
): Promise<number> {
  return recordSponsorStats(
    campaignIds.map((campaignId) => ({ campaignId, metric: "impression" })),
    at,
  );
}

export async function drainSponsorStats(
  opts: { batchSize?: number; scanCount?: number } = {},
): Promise<SponsorStatDelta[]> {
  const { batchSize = 256, scanCount = 500 } = opts;
  const client = await statsRedis();
  if (!client) return [];
  const deltas = new Map<string, { campaignId: string; day: string; impressions: number; clicks: number }>();
  const take = async (keys: string[]): Promise<void> => {
    const values = await client.takeAll(keys);
    for (const [key, count] of values) {
      const parsed = parseSponsorStatsKey(key);
      if (!parsed) continue;
      const id = `${parsed.campaignId}:${parsed.day}`;
      let delta = deltas.get(id);
      if (!delta) {
        delta = { campaignId: parsed.campaignId, day: parsed.day, impressions: 0, clicks: 0 };
        deltas.set(id, delta);
      }
      if (parsed.metric === "impression") delta.impressions += count;
      else delta.clicks += count;
    }
  };
  let cursor = "0";
  let batch: string[] = [];
  const seen = new Set<string>();
  try {
    do {
      const page = await client.scan(cursor, `${SPONSOR_KEY_PREFIX}*`, scanCount);
      cursor = page.cursor;
      for (const key of page.keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (!parseSponsorStatsKey(key)) continue;
        batch.push(key);
      }
      if (batch.length >= batchSize) {
        await take(batch);
        batch = [];
      }
    } while (cursor !== "0");
    if (batch.length > 0) await take(batch);
  } catch {
    console.warn("[ads] sponsor drain skipped: Redis unreachable");
  }
  return [...deltas.values()];
}
