import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { featuredBids, jobQueue } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { resetClock, setClock } from "@/lib/clock";
import { NOTIFY_SPOT_OUTBID } from "@/lib/email/notify";
import { citySpotKey, createFeaturedSubscription, ensureSpot, insertBid, spotBids } from "@/lib/db/queries/spots";
import { ensureProfile } from "@/lib/auth/profile";
import { user } from "@/lib/db/schema";
import { rerankSpots } from "./engine";
import { OUTBID_DEBOUNCE_MS, notifyOutbid, positionChanges } from "./notify";

/**
 * The owner hears when a bid loses ground — once per hour per bid, however
 * many re-ranks happen in that hour — and never for a bid that only moved
 * up, held still, or was never featured to begin with.
 */

afterEach(() => resetClock());

const before = (rows: [string, number | null][]) =>
  rows.map(([listingId, position]) => ({ id: `bid-${listingId}`, listingId, position, status: "active" as const }));
const after = (rows: [string, number | null][]) =>
  rows.map(([listingId, position]) => ({ id: `bid-${listingId}`, listingId, position, amountCents: 1 }));

describe("positionChanges", () => {
  it("names the bid that lost first and the bid that dropped out, and nobody else", () => {
    const changes = positionChanges(
      before([["a", 1], ["b", 2], ["c", 3], ["d", null]]),
      after([["d", 1], ["a", 2], ["b", 3], ["c", null]]),
    );
    expect(changes).toEqual([
      { bidId: "bid-a", listingId: "a", kind: "lost-first", from: 1, to: 2 },
      { bidId: "bid-c", listingId: "c", kind: "dropped-out", from: 3, to: null },
    ]);
  });

  it("is silent for a move up, a hold, a first ranking, and a bid that was pending", () => {
    expect(positionChanges(before([["a", 2], ["b", 1]]), after([["a", 1], ["b", 2]]))).toEqual([
      { bidId: "bid-b", listingId: "b", kind: "lost-first", from: 1, to: 2 },
    ]);
    expect(positionChanges(before([["a", 1]]), after([["a", 1]]))).toEqual([]);
    expect(positionChanges(before([["a", null], ["b", null]]), after([["a", 1], ["b", 2]]))).toEqual([]);
    expect(
      positionChanges(
        [{ id: "bid-p", listingId: "p", position: null, status: "pending" }],
        after([["p", null]]),
      ),
    ).toEqual([]);
  });

  it("a bid that vanished from the ranking (cancelled) is a drop-out when it held a place", () => {
    expect(positionChanges(before([["a", 1], ["b", 2]]), after([["b", 1]]))).toEqual([
      { bidId: "bid-a", listingId: "a", kind: "dropped-out", from: 1, to: null },
    ]);
  });
});

const ADMIN = { role: "admin" as const, userId: "worker" };

async function owner(tx: TestDb) {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Owner", email: `${userId}@example.test` });
  const viewer = { role: "user" as const, userId };
  const { id: profileId } = await ensureProfile(tx, viewer);
  return { viewer, profileId };
}

async function activeBid(tx: TestDb, ctx: ListingCtx, spotId: string, amountCents: number) {
  const o = await owner(tx);
  const listingId = await makeListing(tx, ctx, { ownerId: o.profileId, claimStatus: "verified", tier: "premium" });
  const subscriptionId = await createFeaturedSubscription(tx, o.viewer, {
    listingId, profileId: o.profileId, planId: "P-F", quantity: amountCents / 100, ip: null,
  });
  const bidId = await insertBid(tx, o.viewer, { spotId, listingId, subscriptionId, amountCents, status: "active", ip: null });
  return { listingId, bidId, ...o };
}

async function outbidJobs(tx: TestDb) {
  return tx.select({ payload: jobQueue.payload }).from(jobQueue).where(eq(jobQueue.kind, NOTIFY_SPOT_OUTBID));
}

describe("notifyOutbid through rerankSpots", () => {
  it("queues one job per change with the bid id and the kind, marks the bid, and debounces for an hour", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-23T09:00:00Z"));
      const ctx = await makeScaffold(tx);
      const spot = await ensureSpot(tx, (await owner(tx)).viewer, citySpotKey(ctx.cityId, null));
      const a = await activeBid(tx, ctx, spot.id, 8000);
      const b = await activeBid(tx, ctx, spot.id, 7000);
      const c = await activeBid(tx, ctx, spot.id, 6000);
      await rerankSpots(tx, [spot.id]);
      // First ranking: nobody had a place to lose.
      expect(await outbidJobs(tx)).toEqual([]);

      // A fourth bidder arrives above everyone.
      const d = await activeBid(tx, ctx, spot.id, 9000);
      await rerankSpots(tx, [spot.id]);
      const jobs = await outbidJobs(tx);
      expect(jobs.map((j) => j.payload)).toEqual(
        expect.arrayContaining([
          { bidId: a.bidId, kind: "lost-first" },
          { bidId: c.bidId, kind: "dropped-out" },
        ]),
      );
      expect(jobs).toHaveLength(2);
      const [marked] = await tx.select({ at: featuredBids.outbidNotifiedAt }).from(featuredBids).where(eq(featuredBids.id, a.bidId));
      expect(marked?.at?.toISOString()).toBe("2026-09-23T09:00:00.000Z");

      // Within the hour two more bidders arrive: d loses first (fresh),
      // b drops out (fresh), a drops out too — but a was told at 09:00.
      setClock(new Date("2026-09-23T09:30:00Z"));
      const e = await activeBid(tx, ctx, spot.id, 9800);
      const f = await activeBid(tx, ctx, spot.id, 9700);
      await rerankSpots(tx, [spot.id]);
      const afterEF = await outbidJobs(tx);
      expect(afterEF).toHaveLength(4);
      expect(afterEF.map((j) => j.payload)).toContainEqual({ bidId: d.bidId, kind: "lost-first" });
      expect(afterEF.map((j) => j.payload)).toContainEqual({ bidId: b.bidId, kind: "dropped-out" });
      expect(afterEF.map((j) => j.payload)).not.toContainEqual({ bidId: a.bidId, kind: "dropped-out" });
      void f;

      // Half an hour on: a seventh bidder takes first. e is told (fresh); d
      // drops out but was told at 09:30, so it is not told again yet.
      setClock(new Date("2026-09-23T10:00:01Z"));
      await activeBid(tx, ctx, spot.id, 9900);
      await rerankSpots(tx, [spot.id]);
      const later = await outbidJobs(tx);
      expect(later).toHaveLength(5);
      expect(later.map((j) => j.payload)).toContainEqual({ bidId: e.bidId, kind: "lost-first" });
      const rows = await spotBids(tx, ADMIN, spot.id);
      expect(rows.find((r) => r.id === d.bidId)?.position).toBeNull();
      expect(rows.find((r) => r.id === e.bidId)?.position).toBe(2);
    });
  });

  it("notifyOutbid alone: the debounce window is an hour, and the return value is what was queued", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-23T09:00:00Z"));
      const ctx = await makeScaffold(tx);
      const spot = await ensureSpot(tx, (await owner(tx)).viewer, citySpotKey(ctx.cityId, null));
      const a = await activeBid(tx, ctx, spot.id, 8000);
      const bids = await spotBids(tx, ADMIN, spot.id);
      const held = bids.map((b) => ({ ...b, position: 1 }));
      const lost = bids.map((b) => ({ ...b, position: null }));

      const first = await notifyOutbid(tx, spot.id, held, lost);
      expect(first.map((c) => c.bidId)).toEqual([a.bidId]);
      setClock(new Date(Date.parse("2026-09-23T09:00:00Z") + OUTBID_DEBOUNCE_MS - 1));
      expect(await notifyOutbid(tx, spot.id, held, lost)).toEqual([]);
      setClock(new Date(Date.parse("2026-09-23T09:00:00Z") + OUTBID_DEBOUNCE_MS + 1));
      expect((await notifyOutbid(tx, spot.id, held, lost)).map((c) => c.bidId)).toEqual([a.bidId]);
      expect(await tx.select().from(jobQueue).where(and(eq(jobQueue.kind, NOTIFY_SPOT_OUTBID)))).toHaveLength(2);
    });
  });
});
