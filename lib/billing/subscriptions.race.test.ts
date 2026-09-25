import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { listings, subscriptions, user } from "@/lib/db/schema";
import type { TestDb } from "@/test/db";
import { makeListing } from "@/test/factories";
import { RACE_USER_PREFIX, raceScaffold, sweepRaceRows } from "@/test/race";
import { ensureProfile } from "@/lib/auth/profile";
import * as fx from "./__fixtures__/paypal";
import { ENV, base, recorder } from "./subscriptions.fixtures";
import { startCheckout } from "./subscriptions";

/**
 * The row lock cannot be shown inside `withTestDb`: one connection, one
 * transaction, and a lock never contends with itself. So this opens its own
 * connections, commits a listing, races an activation against a checkout, and
 * cleans up after itself — the same shape as the coupon race test.
 */
describe("startCheckout concurrency", () => {
  const url =
    process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
  const client = postgres(url, { max: 4 });
  const database = drizzle(client, { schema });
  const stamp = randomUUID();
  const userId = `${RACE_USER_PREFIX}${stamp}`;
  const ids = { listing: "" };

  afterAll(async () => {
    // The owner carries the u_race_ prefix and the scaffold "Race …" names,
    // so a failure half-way through setup still leaves nothing behind.
    try {
      await sweepRaceRows(client);
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("waits for an in-flight activation on the listing and then refuses", async () => {
    // Committed fixtures, because the second connection has to see them.
    const ctx = await raceScaffold(database as unknown as TestDb, stamp.slice(0, 8));
    await database.insert(user).values({ id: userId, name: "O", email: `${userId}@example.test` });
    const viewer = { role: "user" as const, userId };
    const { id: profileId } = await ensureProfile(database as unknown as TestDb, viewer);
    ids.listing = await makeListing(database as unknown as TestDb, ctx, {
      ownerId: profileId,
      claimStatus: "claimed",
    });

    // A checkout that has already been through PayPal and is waiting to be
    // activated — the return page's reconcile is running in transaction A.
    const [pending] = await database
      .insert(subscriptions)
      .values({
        listingId: ids.listing,
        userId: profileId,
        provider: "paypal",
        providerPlanId: fx.PLAN_ID,
        providerSubscriptionId: `I-RACE-${stamp.slice(0, 8)}`,
        tier: "premium",
        interval: "annual",
        status: "approval_pending",
      })
      .returning({ id: subscriptions.id });

    let releaseA: () => void = () => {};
    const aHoldsTheRow = new Promise<void>((resolve) => (releaseA = resolve));
    let bStarted: () => void = () => {};
    const bHasStarted = new Promise<void>((resolve) => (bStarted = resolve));
    let bSettled = false;

    // Transaction A: takes the listing row (as applyEffect does when it writes
    // listings.tier), activates the subscription, and holds the transaction
    // open until told to commit.
    const a = database.transaction(async (tx) => {
      await tx.update(listings).set({ tier: "premium" }).where(eq(listings.id, ids.listing));
      await tx.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.id, pending!.id));
      bStarted();
      await aHoldsTheRow;
    });

    // Transaction B: the owner's second tab submits a checkout while A is
    // still open. FOR UPDATE on the listing makes it wait for A.
    await bHasStarted;
    // A unique provider id: this row is committed for real, and the fixture
    // id must never be left behind for another test file to trip over.
    const r = recorder({ subId: `I-RACE-B-${stamp.slice(0, 8)}` });
    const b = database
      .transaction(async (tx) =>
        startCheckout(tx as unknown as TestDb, {
          client: r.client,
          env: ENV,
          viewer,
          profileId,
          listingId: ids.listing,
          ...base,
        }),
      )
      .then((out) => {
        bSettled = true;
        return out;
      });

    // Give B every chance to finish early if it were NOT blocked.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(bSettled, "checkout must wait for the activation to commit").toBe(false);

    releaseA();
    await a;
    const out = await b;

    // B read committed state — the row A activated — and refused. Without
    // the lock it would have read the pending row and created a second
    // PayPal subscription for a listing that already has one.
    expect(out.outcome).toBe("already-subscribed");
    expect(r.created).toHaveLength(0);
    const rows = await database
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(inArray(subscriptions.listingId, [ids.listing]));
    expect(rows).toHaveLength(1);
  });
});
