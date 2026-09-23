import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { awards } from "@/lib/db/schema";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { resetClock, setClock } from "@/lib/clock";
import { listingAwards } from "@/lib/db/queries/awards";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import type { Db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { AWARDS_CRON, awardYearFor, awardsCronOptions, awardsRevalidatePaths, computeAwards } from "./awards";

afterEach(() => resetClock());

async function contest(tx: TestDb, ctx: ListingCtx): Promise<string> {
  const winner = await makeListing(tx, ctx, { name: "Clear Winner", ratingAvg: "4.9", ratingCount: 7 });
  await makeListing(tx, ctx, { ratingAvg: "4.2", ratingCount: 6 });
  await makeListing(tx, ctx, { ratingAvg: "3.5", ratingCount: 9 });
  return winner;
}

describe("awardYearFor", () => {
  it("is the calendar year of the run, in the site's timezone", () => {
    // 1 Jan 2031 12:00 UTC is 1 January in every zone; noon on 31 December likewise.
    expect(awardYearFor(new Date("2031-01-01T12:00:00Z"))).toBe(2031);
    expect(awardYearFor(new Date("2030-12-31T12:00:00Z"))).toBe(2030);
  });
});

/**
 * The cron and the year reading have to agree, and they only do because both
 * are in the site's zone. With a UTC-negative site on a UTC server, the old
 * server-clock schedule fired at 05:23 UTC on 1 January — 21:23 on 31 December
 * locally — and computed the year that was ENDING.
 */
describe("AWARDS_CRON in the site timezone", () => {
  /** The wall-clock fields of `at` in `tz`, as node-cron would match them. */
  function wall(at: Date, tz: string): { minute: number; hour: number; day: number; month: number } {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour12: false, minute: "2-digit", hour: "2-digit", day: "2-digit", month: "2-digit",
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return { minute: get("minute"), hour: get("hour") % 24, day: get("day"), month: get("month") };
  }

  it("is read in the same zone awardYearFor reads the year in", () => {
    expect(awardsCronOptions()).toEqual({ timezone: siteConfig.timezone });
  });

  it("fires on the site's 1 January and computes the year that has just begun, west of UTC too", () => {
    const [minute, hour, day, month] = AWARDS_CRON.split(" ").map(Number);
    const tz = "America/Los_Angeles";
    // 05:23 on 1 January 2031 in Los Angeles is 13:23 UTC.
    const fires = new Date("2031-01-01T13:23:00Z");
    expect(wall(fires, tz)).toEqual({ minute, hour, day, month });
    expect(awardYearFor(fires, tz)).toBe(2031);

    // The server-clock reading of the same expression: still 2030 locally.
    const serverClock = new Date("2031-01-01T05:23:00Z");
    expect(awardYearFor(serverClock, tz)).toBe(2030);
    expect(wall(serverClock, tz).day).toBe(31);
  });
});

describe("awardsRevalidatePaths", () => {
  it("names the index, the year, each town and each winner's page, once each", () => {
    const paths = awardsRevalidatePaths({
      year: 2031,
      skipped: 0,
      created: [
        { awardId: "a", listingId: "l1", cityId: "c1", citySlug: "leeds", categoryId: "k1" },
        { awardId: "b", listingId: "l2", cityId: "c1", citySlug: "leeds", categoryId: "k2" },
      ],
    }, ["/leeds/one", "/leeds/two"]);
    expect(paths).toEqual(["/awards", "/awards/2031", "/awards/2031/leeds", "/leeds/one", "/leeds/two"]);
  });
});

describe("computeAwards", () => {
  it("computes the run year's awards and returns what to revalidate", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2031-01-01T05:00:00Z"));
      const ctx = await makeScaffold(tx);
      const winner = await contest(tx, ctx);

      const outcome = await computeAwards(tx as unknown as Db);
      expect(outcome.result.year).toBe(2031);
      expect(outcome.result.created.map((c) => c.listingId)).toEqual([winner]);
      expect(outcome.revalidate).toContain("/awards");
      expect(outcome.revalidate).toContain("/awards/2031");
      expect(outcome.revalidate.some((p) => /^\/awards\/2031\/[a-z0-9-]+$/.test(p))).toBe(true);
      expect(outcome.revalidate.some((p) => /\/clear-winner$/.test(p))).toBe(true);

      expect((await listingAwards(tx, PUBLIC_VIEWER, winner)).map((a) => a.year)).toEqual([2031]);
    });
  });

  it("takes an explicit year, and running it twice changes nothing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await contest(tx, ctx);

      const first = await computeAwards(tx as unknown as Db, 2040);
      expect(first.result.created).toHaveLength(1);
      const second = await computeAwards(tx as unknown as Db, 2040);
      expect(second.result.created).toEqual([]);
      expect(second.result.skipped).toBe(1);
      // Nothing new, nothing stale: a no-op run does not bust the cache.
      expect(second.revalidate).toEqual([]);

      expect(await tx.select().from(awards).where(eq(awards.year, 2040))).toHaveLength(1);
    });
  });
});
