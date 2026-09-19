import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { badges } from "@/lib/db/schema";
import { makeListing, makeScaffold } from "@/test/factories";
import type { BadgeCounterDelta } from "@/lib/db/queries/badges";
import { flushBadgeCounters } from "./badge-counters";

describe("flushBadgeCounters", () => {
  it("writes a drained batch into the badge rows", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeListing(tx, ctx, { name: "A" });
      const b = await makeListing(tx, ctx, { name: "B" });
      await tx.insert(badges).values({ listingId: a, impressionCount: 2 });

      const drained: BadgeCounterDelta[] = [
        { listingId: a, impressions: 5, clicks: 1 },
        { listingId: b, impressions: 3, clicks: 0 },
      ];
      const applied = await flushBadgeCounters(tx, { drain: async () => drained });

      expect(applied).toBe(2);
      const [rowA] = await tx.select().from(badges).where(eq(badges.listingId, a));
      expect(rowA).toMatchObject({ impressionCount: 7, clickCount: 1 });
      const [rowB] = await tx.select().from(badges).where(eq(badges.listingId, b));
      expect(rowB).toMatchObject({ impressionCount: 3, clickCount: 0 });
    });
  });

  it("does not touch the database when Redis had nothing", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      const drain = vi.fn(async () => []);
      expect(await flushBadgeCounters(tx, { drain })).toBe(0);
      expect(drain).toHaveBeenCalledOnce();
      expect(await tx.select().from(badges)).toHaveLength(0);
    });
  });
});
