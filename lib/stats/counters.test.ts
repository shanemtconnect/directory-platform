import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Real Redis, database 7 (this worktree's, per the wave plan). Nothing here is
 * mocked: the whole point of the counter layer is that INCR and GETDEL behave
 * the way the flush assumes, and a fake would assert my assumptions rather
 * than Redis's behaviour.
 */
process.env.REDIS_URL = "redis://localhost:6380/7";

const { closeStatsRedis, statsRedis } = await import("./redis");
const { COUNTER_TTL_SECONDS, SEEN_TTL_SECONDS, claimDailyView, drainStats, recordStat, recordStats } =
  await import("./counters");
const { STATS_KEY_PREFIX, dayKey, seenKey, statsKey } = await import("./keys");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-09-12T10:00:00Z");
const DAY = dayKey(AT);

async function flush(): Promise<void> {
  const c = await statsRedis();
  if (!c) throw new Error("redis db 7 is not reachable — start docker compose");
  // Only database 7. Never a FLUSHALL: the other worktrees' counters and the
  // dev site's page cache live in the same server.
  await c.flushDb();
}

beforeEach(flush);
afterAll(async () => {
  await flush();
  await closeStatsRedis();
});

describe("recordStat", () => {
  it("increments the key for the listing, the day and the metric", async () => {
    await recordStat(A, "view", AT);
    await recordStat(A, "view", AT);
    await recordStat(A, "impression", AT);

    const c = await statsRedis();
    expect(await c!.get(statsKey(A, DAY, "view"))).toBe("2");
    expect(await c!.get(statsKey(A, DAY, "impression"))).toBe("1");
  });

  it("gives a fresh counter a TTL, so an unflushed key cannot live for ever", async () => {
    await recordStat(A, "view", AT);
    const c = await statsRedis();
    const ttl = await c!.ttl(statsKey(A, DAY, "view"));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(COUNTER_TTL_SECONDS);
  });

  it("refuses a listing id that is not a uuid rather than writing a key", async () => {
    expect(await recordStat("../../etc/passwd", "view", AT)).toBe(false);
    const c = await statsRedis();
    const { keys } = await c!.scan("0", `${STATS_KEY_PREFIX}*`, 100);
    expect(keys).toEqual([]);
  });

  it("never throws when Redis is unreachable", async () => {
    // A beacon that 500s because the cache is down is a worse outage than a
    // lost view: this path is fire-and-forget by design.
    const previous = process.env.REDIS_URL;
    await closeStatsRedis();
    process.env.REDIS_URL = "redis://127.0.0.1:6399/7";
    try {
      expect(await recordStat(A, "view", AT)).toBe(false);
    } finally {
      process.env.REDIS_URL = previous;
      await closeStatsRedis();
    }
  });
});

describe("recordStats", () => {
  it("counts a batch in one call and reports how many landed", async () => {
    const n = await recordStats(
      [
        { listingId: A, metric: "impression" },
        { listingId: B, metric: "impression" },
        { listingId: A, metric: "impression" },
      ],
      AT,
    );

    expect(n).toBe(3);
    const c = await statsRedis();
    expect(await c!.get(statsKey(A, DAY, "impression"))).toBe("2");
    expect(await c!.get(statsKey(B, DAY, "impression"))).toBe("1");
  });

  it("skips the invalid entries and counts the rest", async () => {
    const n = await recordStats([{ listingId: "nope", metric: "view" }, { listingId: A, metric: "view" }], AT);
    expect(n).toBe(1);
  });
});

describe("claimDailyView", () => {
  const IP = "198.51.100.7";

  it("counts the first view from an address and refuses the second the same day", async () => {
    expect(await claimDailyView(IP, A, AT)).toBe(true);
    expect(await claimDailyView(IP, A, AT)).toBe(false);
  });

  it("is per address, per listing and per day", async () => {
    await claimDailyView(IP, A, AT);

    expect(await claimDailyView("203.0.113.9", A, AT)).toBe(true);
    expect(await claimDailyView(IP, B, AT)).toBe(true);
    expect(await claimDailyView(IP, A, new Date("2026-09-13T10:00:00Z"))).toBe(true);
  });

  it("forgets the mark within a day", async () => {
    await claimDailyView(IP, A, AT);
    const c = await statsRedis();
    const ttl = await c!.ttl(seenKey(DAY, IP, A));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SEEN_TTL_SECONDS);
  });

  it("is skipped by the flush rather than drained as a count", async () => {
    await claimDailyView(IP, A, AT);
    await recordStat(A, "view", AT);

    const deltas = await drainStats();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.views).toBe(1);
    // The mark survives the drain, so the address still cannot count twice.
    expect(await claimDailyView(IP, A, AT)).toBe(false);
  });

  it("refuses a listing id that is not a uuid without writing a key", async () => {
    expect(await claimDailyView(IP, "../../etc/passwd", AT)).toBe(false);
    const c = await statsRedis();
    const { keys } = await c!.scan("0", `${STATS_KEY_PREFIX}*`, 100);
    expect(keys).toEqual([]);
  });

  it("counts normally when Redis is unreachable", async () => {
    // The guard is a courtesy to the numbers, not a gate on the request: with
    // no Redis there is no counter to protect either.
    const previous = process.env.REDIS_URL;
    await closeStatsRedis();
    process.env.REDIS_URL = "redis://127.0.0.1:6399/7";
    try {
      expect(await claimDailyView(IP, A, AT)).toBe(true);
    } finally {
      process.env.REDIS_URL = previous;
      await closeStatsRedis();
    }
  });
});

describe("drainStats", () => {
  it("returns one delta per listing and day, with the metrics folded in", async () => {
    await recordStat(A, "view", AT);
    await recordStat(A, "view", AT);
    await recordStat(A, "impression", AT);
    await recordStat(A, "enquiry", AT);
    await recordStat(A, "shortlist_add", AT);
    await recordStat(A, "badge_click", AT);
    await recordStat(B, "view", new Date("2026-09-11T10:00:00Z"));

    const deltas = await drainStats();
    deltas.sort((x, y) => x.listingId.localeCompare(y.listingId));

    expect(deltas).toEqual([
      {
        listingId: A, day: DAY,
        views: 2, impressions: 1, enquiries: 1, shortlistAdds: 1, badgeClicks: 1,
      },
      {
        listingId: B, day: dayKey(new Date("2026-09-11T10:00:00Z")),
        views: 1, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0,
      },
    ]);
  });

  it("takes the counters away, so a second flush cannot double-count", async () => {
    await recordStat(A, "view", AT);

    expect(await drainStats()).toHaveLength(1);
    expect(await drainStats()).toEqual([]);
  });

  it("leaves counters written after the drain started for the next flush", async () => {
    await recordStat(A, "view", AT);
    const first = await drainStats();
    await recordStat(A, "view", AT);
    const second = await drainStats();

    expect(first[0]!.views).toBe(1);
    expect(second[0]!.views).toBe(1);
  });

  it("ignores keys outside the stats namespace", async () => {
    const c = await statsRedis();
    await c!.set("ratelimit:198.51.100.7:1", "9");
    await recordStat(A, "view", AT);

    expect(await drainStats()).toHaveLength(1);
    // Someone else's key is still there — a drain must not be a cache purge.
    expect(await c!.get("ratelimit:198.51.100.7:1")).toBe("9");
  });

  it("ignores a malformed key in the namespace rather than writing it to the database", async () => {
    const c = await statsRedis();
    await c!.set(`${STATS_KEY_PREFIX}not-a-uuid:2026-09-12:view`, "500");
    await c!.set(`${STATS_KEY_PREFIX}${A}:2026-09-12:rm-rf`, "500");

    expect(await drainStats()).toEqual([]);
  });

  it("returns nothing when there is nothing to flush", async () => {
    expect(await drainStats()).toEqual([]);
  });

  it("handles more keys than one SCAN page", async () => {
    const ids = Array.from({ length: 60 }, (_, i) =>
      `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`);
    await recordStats(ids.map((listingId) => ({ listingId, metric: "view" as const })), AT);

    const deltas = await drainStats({ scanCount: 10, batchSize: 7 });
    expect(deltas).toHaveLength(60);
    expect(deltas.every((d) => d.views === 1)).toBe(true);
  });
});
