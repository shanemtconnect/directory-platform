import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { listingStatsDaily } from "@/lib/db/schema";
import { resetClock, setClock } from "@/lib/clock";
import { withTestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";

/** Real Redis, database 7 — this worktree's, per the wave plan. */
process.env.REDIS_URL = "redis://localhost:6380/7";

const { closeStatsRedis, statsRedis } = await import("@/lib/stats/redis");
const { recordStat } = await import("@/lib/stats/counters");
const { dayKey } = await import("@/lib/stats/keys");
const { flushStats } = await import("./flush-stats");

const AT = new Date("2026-09-12T10:00:00Z");
const DAY = dayKey(AT);

async function clear(): Promise<void> {
  const c = await statsRedis();
  if (!c) throw new Error("redis db 7 is not reachable — start docker compose");
  await c.flushDb();
}

beforeEach(async () => {
  setClock(AT);
  await clear();
});
afterAll(async () => {
  resetClock();
  await clear();
  await closeStatsRedis();
});

describe("flushStats", () => {
  it("moves the Redis counters into listing_stats_daily", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      await recordStat(listingId, "view", AT);
      await recordStat(listingId, "view", AT);
      await recordStat(listingId, "impression", AT);

      const written = await flushStats(tx);

      expect(written).toBe(1);
      const [row] = await tx.select().from(listingStatsDaily)
        .where(eq(listingStatsDaily.listingId, listingId));
      expect(row).toMatchObject({ day: DAY, views: 2, impressions: 1 });
    });
  });

  it("adds to the day already there rather than replacing it", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      await recordStat(listingId, "view", AT);
      await flushStats(tx);
      await recordStat(listingId, "view", AT);
      await flushStats(tx);

      const [row] = await tx.select().from(listingStatsDaily)
        .where(eq(listingStatsDaily.listingId, listingId));
      expect(row?.views).toBe(2);
    });
  });

  it("leaves nothing behind in Redis, so a tick cannot double-count", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      await recordStat(listingId, "view", AT);

      await flushStats(tx);

      const c = await statsRedis();
      expect((await c!.scan("0", "stats:*", 100)).keys).toEqual([]);
      expect(await flushStats(tx)).toBe(0);
    });
  });

  it("is a cheap no-op when nothing has been counted", async () => {
    await withTestDb(async (tx) => {
      expect(await flushStats(tx)).toBe(0);
    });
  });

  it("drops counters for a listing that has since been deleted", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const alive = await makeListing(tx, ctx);
      await recordStat(alive, "view", AT);
      await recordStat("99999999-9999-4999-8999-999999999999", "view", AT);

      expect(await flushStats(tx)).toBe(1);
    });
  });
});
