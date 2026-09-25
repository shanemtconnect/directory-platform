import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { TestDb } from "@/test/db";
import { makeListing } from "@/test/factories";
import { RACE_USER_PREFIX, raceScaffold, sweepRaceRows } from "@/test/race";
import * as schema from "@/lib/db/schema";
import { listingImages } from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import { IP, key, owner } from "./photos.fixtures";
import { createOwnerPhoto } from "./photos";

/**
 * The one photos test that cannot use the rollback harness, so it lives in
 * its own file and runs in the race suite (vitest.race.config.ts), alone.
 *
 * Two confirms have to be in flight AT THE SAME TIME against COMMITTED rows
 * for the listing lock to mean anything, and `withTestDb` gives one
 * transaction that is thrown away. So this opens its own connections, commits
 * an owner and a free-tier listing, races two confirms at `max - 1` and
 * cleans up after itself.
 */
describe("createOwnerPhoto concurrency", () => {
  const url =
    process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
  const client = postgres(url, { max: 4 });
  const database = drizzle(client, { schema }) as unknown as TestDb;

  afterAll(async () => {
    // The owner carries the u_race_ prefix and the scaffold "Race …" names,
    // so a failure half-way through setup still leaves nothing behind.
    try {
      await sweepRaceRows(client);
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("lets exactly one of two simultaneous confirms through at the cap", async () => {
    const max = siteConfig.tiers.free.maxImages!;
    const jo = await owner(database, "owner", RACE_USER_PREFIX);
    const ctx = await raceScaffold(database, randomUUID().slice(0, 8));
    const listingId = await makeListing(database, ctx, {
      name: "Race", tier: "free", ownerId: jo.profileId, claimStatus: "claimed",
    });

    for (let n = 0; n < max - 1; n++) {
      const r = await createOwnerPhoto(database, jo.viewer, {
        listingId, storagePath: key(listingId, n), ip: IP,
      });
      expect(r.outcome).toBe("created");
    }

    const attempt = (n: number) =>
      database.transaction(async (tx) =>
        createOwnerPhoto(tx as unknown as TestDb, jo.viewer, {
          listingId, storagePath: key(listingId, 100 + n), ip: IP,
        }),
      );
    const [a, b] = await Promise.all([attempt(1), attempt(2)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["created", "limit"]);

    const rows = await database
      .select({ sortOrder: listingImages.sortOrder, isPrimary: listingImages.isPrimary })
      .from(listingImages)
      .where(eq(listingImages.listingId, listingId))
      .orderBy(asc(listingImages.sortOrder));
    expect(rows).toHaveLength(max);
    expect(rows.map((r) => r.sortOrder)).toEqual([...Array(max).keys()]);
    expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);
  });
});
