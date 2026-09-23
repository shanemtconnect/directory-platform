import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.REDIS_URL = "redis://localhost:6380/12";

const { closeStatsRedis, statsRedis } = await import("@/lib/stats/redis");
const {
  FEATURED_CLICK_KEY_PREFIX, drainFeaturedClicks, featuredClickKey, parseFeaturedClickKey, recordFeaturedClicks,
} = await import("./clicks");
const { dayKey, statsKey } = await import("@/lib/stats/keys");
const { COUNTER_TTL_SECONDS } = await import("@/lib/stats/counters");

const SPOT = "11111111-1111-4111-8111-111111111111";
const LISTING = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const AT = new Date("2026-09-22T10:00:00Z");
const DAY = dayKey(AT);

async function flush(): Promise<void> {
  const c = await statsRedis();
  if (!c) throw new Error("redis db 12 is not reachable — start docker compose");
  await c.flushDb();
}
beforeEach(flush);
afterAll(async () => {
  await flush();
  await closeStatsRedis();
});

describe("featured click keys", () => {
  it("round-trip and refuse anything that is not ours", () => {
    const key = featuredClickKey(SPOT, LISTING, DAY);
    expect(key).toBe(`fclick:${SPOT}:${LISTING}:${DAY}`);
    expect(parseFeaturedClickKey(key)).toEqual({ spotId: SPOT, listingId: LISTING, day: DAY });
    expect(parseFeaturedClickKey(statsKey(LISTING, DAY, "view"))).toBeNull();
    expect(parseFeaturedClickKey(`${FEATURED_CLICK_KEY_PREFIX}${SPOT}:nope:${DAY}`)).toBeNull();
    expect(parseFeaturedClickKey(`${FEATURED_CLICK_KEY_PREFIX}${SPOT}:${LISTING}:${DAY}:extra`)).toBeNull();
  });
});

describe("recordFeaturedClicks / drainFeaturedClicks", () => {
  it("counts per spot, listing and day with a TTL, ignores bad ids, and the drain empties the keys", async () => {
    expect(await recordFeaturedClicks([{ spotId: SPOT, listingId: LISTING }, { spotId: SPOT, listingId: LISTING }], AT)).toBe(2);
    expect(await recordFeaturedClicks([{ spotId: SPOT, listingId: OTHER }, { spotId: "x", listingId: LISTING }], AT)).toBe(1);
    const c = (await statsRedis())!;
    expect(await c.get(featuredClickKey(SPOT, LISTING, DAY))).toBe("2");
    const ttl = await c.ttl(featuredClickKey(SPOT, LISTING, DAY));
    expect(ttl).toBeGreaterThan(COUNTER_TTL_SECONDS - 60);

    const deltas = await drainFeaturedClicks();
    expect(deltas.sort((a, b) => a.listingId.localeCompare(b.listingId))).toEqual([
      { spotId: SPOT, listingId: LISTING, day: DAY, clicks: 2 },
      { spotId: SPOT, listingId: OTHER, day: DAY, clicks: 1 },
    ]);
    expect(await drainFeaturedClicks()).toEqual([]);
  });
});
