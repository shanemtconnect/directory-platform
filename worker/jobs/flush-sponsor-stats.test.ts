import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.REDIS_URL = "redis://localhost:6380/11";

const { closeStatsRedis, statsRedis } = await import("@/lib/stats/redis");
const { recordSponsorStat } = await import("@/lib/ads/counters");
const { flushSponsorStats } = await import("./flush-sponsor-stats");
const { withTestDb } = await import("@/test/db");
const { profiles, sponsorCampaigns, sponsorStatsDaily, user } = await import("@/lib/db/schema");
const { dayKey } = await import("@/lib/stats/keys");

const AT = new Date("2026-09-22T10:00:00Z");

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

describe("flushSponsorStats", () => {
  it("moves the counters into sponsor_stats_daily and drops those for a campaign that is gone", async () => {
    await withTestDb(async (tx) => {
      const userId = `u_${randomUUID()}`;
      await tx.insert(user).values({ id: userId, name: "A", email: `${userId}@example.com` });
      const [p] = await tx.insert(profiles).values({ userId }).returning({ id: profiles.id });
      const [c] = await tx
        .insert(sponsorCampaigns)
        .values({
          advertiserId: p!.id, name: "Acme", title: "t", blurb: "b",
          targetUrl: "https://acme.example/", placements: ["search"],
        })
        .returning({ id: sponsorCampaigns.id });
      await recordSponsorStat(c!.id, "impression", AT);
      await recordSponsorStat(c!.id, "impression", AT);
      await recordSponsorStat(c!.id, "click", AT);
      await recordSponsorStat(randomUUID(), "impression", AT);

      expect(await flushSponsorStats(tx)).toBe(1);
      const [row] = await tx.select().from(sponsorStatsDaily).where(eq(sponsorStatsDaily.campaignId, c!.id));
      expect(row).toMatchObject({ day: dayKey(AT), impressions: 2, clicks: 1 });
      expect(await flushSponsorStats(tx)).toBe(0);
    });
  });
});
