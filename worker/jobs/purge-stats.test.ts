import { afterEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import { listingStatsDaily } from "@/lib/db/schema";
import { makeListing, makeScaffold } from "@/test/factories";
import { resetClock, setClock } from "@/lib/clock";
import { siteConfig } from "@/config/site.config";
import type { Db } from "@/lib/db/client";
import { purgeStats, statsCutoffDay } from "./purge-stats";

afterEach(() => resetClock());

async function seedDay(tx: TestDb, listingId: string, day: string): Promise<void> {
  await tx.insert(listingStatsDaily).values({ listingId, day, views: 1 });
}

async function daysLeft(tx: TestDb): Promise<string[]> {
  return (await tx.select({ day: listingStatsDaily.day }).from(listingStatsDaily))
    .map((r) => r.day).sort();
}

describe("purge-stats", () => {
  it("ships with four hundred days of retention", () => {
    expect(siteConfig.stats.retentionDays).toBe(400);
  });

  it("keeps exactly retentionDays days ending today, in the site timezone", () => {
    // 400 days ending 2026-09-12 inclusive start on 2025-08-09.
    setClock(new Date("2026-09-12T10:00:00Z"));
    expect(statsCutoffDay(400)).toBe("2025-08-09");
    // 23:30 UTC is already the 13th in Europe/London during BST, so "today"
    // — and with it the cutoff — is the site's day, not the server's.
    setClock(new Date("2026-06-12T23:30:00Z"));
    expect(statsCutoffDay(30)).toBe("2026-05-15");
  });

  it("never keeps less than the thirty-day floor, whatever the config says", () => {
    setClock(new Date("2026-09-12T10:00:00Z"));
    expect(statsCutoffDay(5)).toBe(statsCutoffDay(30));
    expect(statsCutoffDay(Number.NaN)).toBe(statsCutoffDay(30));
  });

  it("deletes rows older than the window and leaves the window alone", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-12T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const oldest = statsCutoffDay(siteConfig.stats.retentionDays);
      await seedDay(tx, listingId, "2025-01-01");
      await seedDay(tx, listingId, "2025-08-08");
      await seedDay(tx, listingId, oldest);
      await seedDay(tx, listingId, "2026-09-12");

      expect(await purgeStats(tx as unknown as Db)).toBe(2);
      expect(await daysLeft(tx)).toEqual([oldest, "2026-09-12"]);
    });
  });

  it("is a cheap no-op when nothing is old enough", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-12T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      await seedDay(tx, listingId, "2026-09-11");

      expect(await purgeStats(tx as unknown as Db)).toBe(0);
      expect(await daysLeft(tx)).toEqual(["2026-09-11"]);
    });
  });
});
