import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { awards } from "@/lib/db/schema";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { resetClock, setClock } from "@/lib/clock";
import { listingAwards } from "@/lib/db/queries/awards";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import type { Db } from "@/lib/db/client";
import { awardYearFor, awardsRevalidatePaths, computeAwards } from "./awards";

afterEach(() => resetClock());

async function contest(tx: TestDb, ctx: ListingCtx): Promise<string> {
  const winner = await makeListing(tx, ctx, { name: "Clear Winner", ratingAvg: "4.9", ratingCount: 7 });
  await makeListing(tx, ctx, { ratingAvg: "4.2", ratingCount: 6 });
  await makeListing(tx, ctx, { ratingAvg: "3.5", ratingCount: 9 });
  return winner;
}

describe("awardYearFor", () => {
  it("is the calendar year of the run, in the site's timezone", () => {
    // 1 January 00:30 in Europe/London is still 31 December in UTC-only
    // reasoning during winter? No — London is UTC in January. Use a zone-safe
    // instant instead: 1 Jan 2031 03:00 UTC is 1 Jan everywhere west of +21.
    expect(awardYearFor(new Date("2031-01-01T03:00:00Z"))).toBe(2031);
    expect(awardYearFor(new Date("2030-12-31T12:00:00Z"))).toBe(2030);
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
