import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { featuredBids, jobQueue } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { resetClock, setClock } from "@/lib/clock";
import { NOTIFY_SPOT_OUTBID } from "@/lib/email/notify";
import {
  attachFeaturedProvider, citySpotKey, createFeaturedSubscription, currentFeaturedSubscription, ensureSpot, insertBid, spotBids,
} from "@/lib/db/queries/spots";
import { featuredSubscriptions, subscriptions } from "@/lib/db/schema";
import { createPendingSubscription } from "@/lib/db/queries/billing";
import type { PayPalClient } from "@/lib/billing/paypal";
import { placeBid } from "./bidding";
import { ensureProfile } from "@/lib/auth/profile";
import { user } from "@/lib/db/schema";
import { rerankSpots, settleSpots } from "./engine";
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
      // a needs max(90+10%, 90+5) = 99 to retake first; c needs the lowest featured (70) + 1.
      expect(jobs.map((j) => j.payload)).toEqual(
        expect.arrayContaining([
          { bidId: a.bidId, kind: "lost-first", amountCents: 9900 },
          { bidId: c.bidId, kind: "dropped-out", amountCents: 7100 },
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
      const payloads = afterEF.map((j) => j.payload as { bidId: string; kind: string });
      expect(payloads).toContainEqual(expect.objectContaining({ bidId: d.bidId, kind: "lost-first" }));
      expect(payloads).toContainEqual(expect.objectContaining({ bidId: b.bidId, kind: "dropped-out" }));
      expect(payloads.some((p) => p.bidId === a.bidId && p.kind === "dropped-out")).toBe(false);
      void f;

      // Half an hour on: a seventh bidder takes first. e is told (fresh); d
      // drops out but was told at 09:30, so it is not told again yet.
      setClock(new Date("2026-09-23T10:00:01Z"));
      await activeBid(tx, ctx, spot.id, 9900);
      await rerankSpots(tx, [spot.id]);
      const later = await outbidJobs(tx);
      expect(later).toHaveLength(5);
      expect(later.map((j) => j.payload)).toContainEqual(expect.objectContaining({ bidId: e.bidId, kind: "lost-first" }));
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

      const first = await notifyOutbid(tx, spot, held, lost);
      expect(first.map((c) => c.bidId)).toEqual([a.bidId]);
      setClock(new Date(Date.parse("2026-09-23T09:00:00Z") + OUTBID_DEBOUNCE_MS - 1));
      expect(await notifyOutbid(tx, spot, held, lost)).toEqual([]);
      setClock(new Date(Date.parse("2026-09-23T09:00:00Z") + OUTBID_DEBOUNCE_MS + 1));
      expect((await notifyOutbid(tx, spot, held, lost)).map((c) => c.bidId)).toEqual([a.bidId]);
      expect(await tx.select().from(jobQueue).where(and(eq(jobQueue.kind, NOTIFY_SPOT_OUTBID)))).toHaveLength(2);
    });
  });
});

describe("I1: an owner lowering their own bid is not told they were outbid", () => {
  it("skips the actor's own change through settleSpots, and through placeBid's lowering branch", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-23T09:00:00Z"));
      const ctx = await makeScaffold(tx);
      const spot = await ensureSpot(tx, (await owner(tx)).viewer, citySpotKey(ctx.cityId, null));
      const a = await activeBid(tx, ctx, spot.id, 9000);
      const b = await activeBid(tx, ctx, spot.id, 8000);
      const c = await activeBid(tx, ctx, spot.id, 7000);
      const d = await activeBid(tx, ctx, spot.id, 6000);
      await rerankSpots(tx, [spot.id]);
      expect(await outbidJobs(tx)).toEqual([]);

      // a lowers from #1 to below everyone: silent for a; nobody else lost anything.
      await tx.update(featuredBids).set({ amountCents: 5000, amountSetAt: new Date() }).where(eq(featuredBids.id, a.bidId));
      await settleSpots(tx, [spot.id], { client: null }, [], { silentListingId: a.listingId });
      expect(await outbidJobs(tx)).toEqual([]);
      void b; void c; void d;

      // The same through the real lowering path: a live subscription with a
      // provider id, then placeBid with a smaller amount.
      const e = await activeBid(tx, ctx, spot.id, 12000);
      const tier = await createPendingSubscription(tx, e.viewer, {
        listingId: e.listingId, profileId: e.profileId, tier: "premium", interval: "monthly", providerPlanId: "P-1", ip: null,
      });
      await tx.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.id, tier));
      await rerankSpots(tx, [spot.id]);
      // e's arrival is a real change for b (lost first) and d (dropped out).
      expect(await outbidJobs(tx)).toHaveLength(2);
      const sub = (await currentFeaturedSubscription(tx, ADMIN, e.listingId))!;
      await attachFeaturedProvider(tx, e.viewer, sub.id, { providerSubscriptionId: "I-E", approveUrl: null });
      await tx.update(featuredSubscriptions).set({ status: "active", quantity: 120 }).where(eq(featuredSubscriptions.id, sub.id));
      const client: PayPalClient = {
        createSubscription: async () => ({ id: "I-X", status: "APPROVAL_PENDING", approveUrl: "https://paypal.test/a" }),
        getSubscription: async () => null,
        cancelSubscription: async () => {},
        manageUrl: async () => null,
        verifyWebhookSignature: async () => true,
        reviseSubscription: async () => ({ approveUrl: "https://paypal.test/r" }),
      };
      const out = await placeBid(tx, {
        client, env: { PAYPAL_PLAN_FEATURED: "P-F" }, viewer: e.viewer, profileId: e.profileId,
        listingId: e.listingId, spot: citySpotKey(ctx.cityId, null), amountCents: 5500, ip: null,
      });
      expect(out.outcome).toBe("applied");
      const rows = await spotBids(tx, ADMIN, spot.id);
      expect(rows.find((r) => r.id === e.bidId)?.position).toBeNull();
      // e dropped out by its own hand: no job for e; b moved up to #1: no job either.
      const jobs = await outbidJobs(tx);
      expect(jobs).toHaveLength(2);
      expect(jobs.some((j) => (j.payload as { bidId: string }).bidId === e.bidId)).toBe(false);
    });
  });
});
