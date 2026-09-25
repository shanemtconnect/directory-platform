import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { featuredSubscriptions, subscriptions, user } from "@/lib/db/schema";
import type { TestDb } from "@/test/db";
import { makeListing } from "@/test/factories";
import { RACE_USER_PREFIX, raceScaffold, sweepRaceRows } from "@/test/race";
import { ensureProfile } from "@/lib/auth/profile";
import { citySpotKey } from "@/lib/db/queries/spots";
import { createPendingSubscription } from "@/lib/db/queries/billing";
import { bid, fakeClient, type Bidder } from "./bidding.fixtures";

/**
 * Two first bids from one listing at once must serialise on the listing row.
 * Commits real rows so the two transactions genuinely contend, which is why it
 * lives in its own file and runs in the race suite (vitest.race.config.ts),
 * alone.
 */

describe("I8 — two first bids at once", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
  const conn = postgres(url, { max: 4 });
  const database = drizzle(conn, { schema });
  const stamp = randomUUID();
  const userId = `${RACE_USER_PREFIX}${stamp}`;
  const ids = { listing: "" };

  afterAll(async () => {
    // The owner carries the u_race_ prefix and the scaffold "Race …" names,
    // so a failure half-way through setup still leaves nothing behind.
    try {
      await sweepRaceRows(conn);
    } finally {
      await conn.end({ timeout: 5 });
    }
  });

  it("serialise on the listing: one PayPal subscription, the second bid told to finish the first approval", async () => {
    const db = database as unknown as TestDb;
    const ctx = await raceScaffold(db, stamp.slice(0, 8));
    await database.insert(user).values({ id: userId, name: "O", email: `${userId}@example.test` });
    const viewer = { role: "user" as const, userId };
    const { id: profileId } = await ensureProfile(db, viewer);
    ids.listing = await makeListing(db, ctx, { ownerId: profileId, claimStatus: "verified", tier: "premium" });
    const tierSub = await createPendingSubscription(db, viewer, { listingId: ids.listing, profileId, tier: "premium", interval: "monthly", providerPlanId: "P-1", ip: null });
    await database.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.id, tierSub));

    const { client, calls } = fakeClient({ delayCreateMs: 150 });
    const who: Bidder = { viewer, profileId, listingId: ids.listing, name: "Racer" };
    const [one, two] = await Promise.all([
      database.transaction((tx) => bid(tx as unknown as TestDb, client, who, citySpotKey(ctx.cityId, null), 6000)),
      database.transaction((tx) => bid(tx as unknown as TestDb, client, who, citySpotKey(ctx.cityId, ctx.primaryCategoryId), 5000)),
    ]);
    const outcomes = [one.outcome, two.outcome].sort();
    expect(outcomes).toEqual(["approval", "awaiting-approval"]);
    expect(calls.created).toHaveLength(1);
    const subs = await database.select({ id: featuredSubscriptions.id }).from(featuredSubscriptions).where(eq(featuredSubscriptions.listingId, ids.listing));
    expect(subs).toHaveLength(1);
  });
});
