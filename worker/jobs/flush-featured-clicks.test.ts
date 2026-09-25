import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.REDIS_URL = "redis://localhost:6380/5";

const { closeStatsRedis, statsRedis } = await import("@/lib/stats/redis");
const { recordFeaturedClicks } = await import("@/lib/spots/clicks");
const { flushFeaturedClicks } = await import("./flush-featured-clicks");
const { withTestDb } = await import("@/test/db");
const { featuredClicksDaily } = await import("@/lib/db/schema");
const { makeListing, makeScaffold } = await import("@/test/factories");
const { citySpotKey, ensureSpot, featuredClicksForListing } = await import("@/lib/db/queries/spots");
const { ensureProfile } = await import("@/lib/auth/profile");
const { user } = await import("@/lib/db/schema");
const { dayKey } = await import("@/lib/stats/keys");

const AT = new Date("2026-09-22T10:00:00Z");

async function flush(): Promise<void> {
  const c = await statsRedis();
  if (!c) throw new Error("redis db 5 is not reachable — start docker compose");
  await c.flushDb();
}
beforeEach(flush);
afterAll(async () => {
  await flush();
  await closeStatsRedis();
});

describe("flushFeaturedClicks", () => {
  it("moves the counters into featured_clicks_daily, drops those for a spot or listing that is gone, and the owner can read theirs", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const userId = `u_${randomUUID()}`;
      await tx.insert(user).values({ id: userId, name: "O", email: `${userId}@example.test` });
      const viewer = { role: "user" as const, userId };
      const { id: profileId } = await ensureProfile(tx, viewer);
      const listingId = await makeListing(tx, ctx, { ownerId: profileId });
      const stranger = await makeListing(tx, ctx);
      const spot = await ensureSpot(tx, viewer, citySpotKey(ctx.cityId, null));

      await recordFeaturedClicks([{ spotId: spot.id, listingId }, { spotId: spot.id, listingId }, { spotId: spot.id, listingId: stranger }], AT);
      await recordFeaturedClicks([{ spotId: randomUUID(), listingId }, { spotId: spot.id, listingId: randomUUID() }], AT);

      expect(await flushFeaturedClicks(tx)).toBe(2);
      const rows = await tx.select().from(featuredClicksDaily).where(eq(featuredClicksDaily.listingId, listingId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ spotId: spot.id, day: dayKey(AT), clicks: 2 });
      expect(await flushFeaturedClicks(tx)).toBe(0);

      // Additive on a second flush.
      await recordFeaturedClicks([{ spotId: spot.id, listingId }], AT);
      await flushFeaturedClicks(tx);
      const mine = await featuredClicksForListing(tx, viewer, { listingId, profileId, days: 30 }, AT);
      expect(mine.get(spot.id)).toBe(3);
      // The owner gate: somebody else's listing reads as nothing.
      const theirs = await featuredClicksForListing(tx, viewer, { listingId: stranger, profileId, days: 30 }, AT);
      expect(theirs.size).toBe(0);
    });
  });
});
