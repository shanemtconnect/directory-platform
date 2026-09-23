import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.REDIS_URL = "redis://localhost:6380/11";

const { closeStatsRedis, statsRedis } = await import("@/lib/stats/redis");
const { drainSponsorStats, recordSponsorImpressions, recordSponsorStat } = await import("./counters");
const { SPONSOR_KEY_PREFIX, parseSponsorStatsKey, sponsorStatsKey } = await import("./keys");
const { dayKey, statsKey } = await import("@/lib/stats/keys");
const { COUNTER_TTL_SECONDS } = await import("@/lib/stats/counters");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-09-22T10:00:00Z");
const DAY = dayKey(AT);

async function flush(): Promise<void> {
  const c = await statsRedis();
  if (!c) throw new Error("redis db 11 is not reachable — start docker compose");
  await c.flushDb();
}

beforeEach(flush);
afterAll(async () => {
  await flush();
  await closeStatsRedis();
});

describe("sponsor keys", () => {
  it("round-trip and refuse anything that is not ours", () => {
    const key = sponsorStatsKey(A, DAY, "click");
    expect(key).toBe(`sponsor:${A}:${DAY}:click`);
    expect(parseSponsorStatsKey(key)).toEqual({ campaignId: A, day: DAY, metric: "click" });
    expect(parseSponsorStatsKey(statsKey(A, DAY, "view"))).toBeNull();
    expect(parseSponsorStatsKey(`${SPONSOR_KEY_PREFIX}${A}:${DAY}:view`)).toBeNull();
    expect(parseSponsorStatsKey(`${SPONSOR_KEY_PREFIX}nope:${DAY}:click`)).toBeNull();
  });
});

describe("recordSponsorStat", () => {
  it("increments per campaign, day and metric with a TTL", async () => {
    await recordSponsorStat(A, "impression", AT);
    await recordSponsorStat(A, "impression", AT);
    await recordSponsorStat(A, "click", AT);
    await recordSponsorImpressions([B, "not-a-uuid"], AT);
    const c = await statsRedis();
    expect(await c!.get(sponsorStatsKey(A, DAY, "impression"))).toBe("2");
    expect(await c!.get(sponsorStatsKey(A, DAY, "click"))).toBe("1");
    expect(await c!.get(sponsorStatsKey(B, DAY, "impression"))).toBe("1");
    const ttl = await c!.ttl(sponsorStatsKey(A, DAY, "impression"));
    expect(ttl).toBeGreaterThan(COUNTER_TTL_SECONDS - 60);
    expect(ttl).toBeLessThanOrEqual(COUNTER_TTL_SECONDS);
  });

  it("refuses a bad id or metric without touching Redis", async () => {
    expect(await recordSponsorStat("nope", "impression", AT)).toBe(false);
    expect(await recordSponsorStat(A, "view" as never, AT)).toBe(false);
  });
});

describe("drainSponsorStats", () => {
  it("takes everything once, merged per campaign and day, and leaves listing counters alone", async () => {
    await recordSponsorStat(A, "impression", AT);
    await recordSponsorStat(A, "impression", AT);
    await recordSponsorStat(A, "click", AT);
    await recordSponsorStat(B, "impression", new Date(AT.getTime() + 86_400_000));
    const c = await statsRedis();
    await c!.set(statsKey(A, DAY, "view"), "9");
    await c!.set(`${SPONSOR_KEY_PREFIX}garbage`, "5");

    const deltas = await drainSponsorStats();
    expect(deltas.sort((x, y) => x.campaignId.localeCompare(y.campaignId))).toEqual([
      { campaignId: A, day: DAY, impressions: 2, clicks: 1 },
      { campaignId: B, day: dayKey(new Date(AT.getTime() + 86_400_000)), impressions: 1, clicks: 0 },
    ]);
    expect(await drainSponsorStats()).toEqual([]);
    expect(await c!.get(statsKey(A, DAY, "view"))).toBe("9");
    expect(await c!.get(`${SPONSOR_KEY_PREFIX}garbage`)).toBe("5");
  });
});
