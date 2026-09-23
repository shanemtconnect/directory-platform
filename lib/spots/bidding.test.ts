import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { featuredBids, featuredSubscriptions, listings, subscriptions, user } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeCategoryInCity, makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { ensureProfile } from "@/lib/auth/profile";
import { resetClock, setClock } from "@/lib/clock";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { createPendingSubscription } from "@/lib/db/queries/billing";
import {
  citySpotKey,
  currentFeaturedSubscription,
  featuredForScope,
  findSpot,
  spotBids,
  type SpotKey,
} from "@/lib/db/queries/spots";
import { processPayPalWebhook } from "@/lib/billing/process";
import type { PayPalClient } from "@/lib/billing/paypal";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { cancelOwnBid, placeBid } from "./bidding";
import { processFeaturedEvent } from "./webhook";
import { parseEvent, type PayPalEvent } from "@/lib/billing/webhooks";

const ENV = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", PAYPAL_WEBHOOK_ID: "WH", PAYPAL_PLAN_FEATURED: "P-F" };

afterEach(() => resetClock());

/* ------------------------------------------------------------- fake PayPal */

interface Calls {
  created: { customId: string; quantity: number | null | undefined; planId: string }[];
  revised: { id: string; quantity: number }[];
  cancelled: string[];
}

function fakeClient(opts: { revise?: boolean; failRevise?: boolean } = {}): { client: PayPalClient; calls: Calls } {
  const calls: Calls = { created: [], revised: [], cancelled: [] };
  let n = 0;
  const client: PayPalClient = {
    createSubscription: async (input) => {
      calls.created.push({ customId: input.customId, quantity: input.quantity, planId: input.planId });
      n++;
      return { id: `I-F${n}`, status: "APPROVAL_PENDING", approveUrl: `https://paypal.test/approve/${n}` };
    },
    getSubscription: async () => null,
    cancelSubscription: async (id) => {
      calls.cancelled.push(id);
    },
    manageUrl: async () => null,
    verifyWebhookSignature: async () => true,
    ...(opts.revise === false
      ? {}
      : {
          reviseSubscription: async (id, input) => {
            if (opts.failRevise) throw new Error("PayPal revise failed");
            calls.revised.push({ id, quantity: input.quantity });
            return { approveUrl: `https://paypal.test/revise/${id}/${input.quantity}` };
          },
        }),
  };
  return { client, calls };
}

/* ------------------------------------------------------------------ seeding */

interface Bidder {
  viewer: { role: "user"; userId: string };
  profileId: string;
  listingId: string;
  name: string;
}

async function makeBidder(tx: TestDb, ctx: ListingCtx, name: string, patch: Partial<typeof listings.$inferInsert> = {}, paid = true): Promise<Bidder> {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name, email: `${userId}@example.test` });
  const viewer = { role: "user" as const, userId };
  const { id: profileId } = await ensureProfile(tx, viewer);
  const listingId = await makeListing(tx, ctx, {
    name,
    ownerId: profileId,
    claimStatus: "verified",
    tier: paid ? "premium" : "free",
    ...patch,
  });
  if (paid) {
    const id = await createPendingSubscription(tx, viewer, {
      listingId, profileId, tier: "premium", interval: "monthly", providerPlanId: "P-1", ip: null,
    });
    await tx.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.id, id));
  }
  return { viewer, profileId, listingId, name };
}

async function bid(tx: TestDb, client: PayPalClient, who: Bidder, spot: SpotKey, amountCents: number) {
  return placeBid(tx, {
    client, env: ENV, viewer: who.viewer, profileId: who.profileId, listingId: who.listingId, spot, amountCents, ip: "1.1.1.1",
  });
}

/** PayPal's confirmation for the listing's featured subscription. */
async function confirm(tx: TestDb, client: PayPalClient, who: Bidder, type = "BILLING.SUBSCRIPTION.ACTIVATED", quantity?: number) {
  const sub = await currentFeaturedSubscription(tx, ADMIN_VIEWER, who.listingId);
  if (sub === null) throw new Error("no featured subscription to confirm");
  const event = parseEvent({
    id: `WH-${randomUUID()}`,
    event_type: type,
    create_time: "2026-09-22T09:00:00Z",
    resource: {
      id: sub.providerSubscriptionId,
      custom_id: sub.id,
      status: "ACTIVE",
      plan_id: "P-F",
      quantity: String(quantity ?? sub.requestedQuantity),
      billing_info: { next_billing_time: "2026-10-22T09:00:00Z" },
    },
  }) as PayPalEvent;
  return processFeaturedEvent(tx, { event, client, env: ENV });
}

async function lapse(tx: TestDb, client: PayPalClient, who: Bidder, type = "BILLING.SUBSCRIPTION.CANCELLED") {
  const sub = await currentFeaturedSubscription(tx, ADMIN_VIEWER, who.listingId);
  if (sub === null) throw new Error("no featured subscription to lapse");
  const event = parseEvent({
    id: `WH-${randomUUID()}`,
    event_type: type,
    create_time: "2026-09-22T09:00:00Z",
    resource: { id: sub.providerSubscriptionId, custom_id: sub.id, status: "CANCELLED", plan_id: "P-F" },
  }) as PayPalEvent;
  return processFeaturedEvent(tx, { event, client, env: ENV });
}

async function board(tx: TestDb, cityId: string): Promise<string[]> {
  return (await featuredForScope(tx, PUBLIC_VIEWER, { type: "city", cityId })).map((r) => `${r.position}:${r.name}`);
}

async function quantities(tx: TestDb, who: Bidder[]): Promise<Record<string, { requested: number; confirmed: number; status: string } | null>> {
  const out: Record<string, { requested: number; confirmed: number; status: string } | null> = {};
  for (const w of who) {
    const [row] = await tx
      .select({ requested: featuredSubscriptions.requestedQuantity, confirmed: featuredSubscriptions.quantity, status: featuredSubscriptions.status })
      .from(featuredSubscriptions)
      .where(eq(featuredSubscriptions.listingId, w.listingId))
      .orderBy(featuredSubscriptions.createdAt);
    out[w.name] = row ?? null;
  }
  return out;
}

async function bidRows(tx: TestDb, listingId: string) {
  return tx
    .select({ amount: featuredBids.amountCents, pending: featuredBids.pendingAmountCents, status: featuredBids.status, position: featuredBids.position })
    .from(featuredBids)
    .where(eq(featuredBids.listingId, listingId));
}

/* -------------------------------------------------------------------- tests */

describe("placeBid — gates", () => {
  it("refuses before writing anything when PayPal or the featured plan is not configured", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const { client } = fakeClient();
      expect((await placeBid(tx, { client: null, env: ENV, viewer: a.viewer, profileId: a.profileId, listingId: a.listingId, spot: citySpotKey(ctx.cityId, null), amountCents: 6000, ip: null })).outcome).toBe("not-configured");
      expect((await placeBid(tx, { client, env: { ...ENV, PAYPAL_PLAN_FEATURED: "" }, viewer: a.viewer, profileId: a.profileId, listingId: a.listingId, spot: citySpotKey(ctx.cityId, null), amountCents: 6000, ip: null })).outcome).toBe("not-configured");
      expect(await findSpot(tx, PUBLIC_VIEWER, citySpotKey(ctx.cityId, null))).toBeNull();
    });
  });

  it("refuses a stranger, an unpaid listing, a foreign category and a made-up area", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const free = await makeBidder(tx, ctx, "Freebie", {}, false);
      const other = await makeCategoryInCity(tx, ctx.verticalId, ctx.cityId, "Hotel Venues");
      const { client, calls } = fakeClient();
      const stranger = await makeBidder(tx, ctx, "Stranger");

      const asStranger = await placeBid(tx, { client, env: ENV, viewer: stranger.viewer, profileId: stranger.profileId, listingId: a.listingId, spot: citySpotKey(ctx.cityId, null), amountCents: 6000, ip: null });
      expect(asStranger.outcome).toBe("not-owner");

      const unpaid = await bid(tx, client, free, citySpotKey(ctx.cityId, null), 6000);
      expect(unpaid).toEqual({ outcome: "not-eligible", reason: "no-subscription" });

      expect((await bid(tx, client, a, citySpotKey(ctx.cityId, other), 6000)).outcome).toBe("not-your-category");
      expect((await bid(tx, client, a, citySpotKey(randomUUID(), null), 6000)).outcome).toBe("no-such-area");
      expect(calls.created).toHaveLength(0);
    });
  });

  it("refuses a bid below the floor, and one that would not take first, with the minimum to do so", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const b = await makeBidder(tx, ctx, "Bravo");
      const { client } = fakeClient();
      const spot = citySpotKey(ctx.cityId, null);
      expect(await bid(tx, client, a, spot, 4900)).toEqual({ outcome: "rejected", reason: "below-floor", minimum: 5000 });
      expect((await bid(tx, client, a, spot, 6000)).outcome).toBe("approval");
      await confirm(tx, client, a);
      // 6000 + max(10%, 5) = 6600.
      expect(await bid(tx, client, b, spot, 6500)).toEqual({ outcome: "rejected", reason: "below-first", minimum: 6600 });
      expect(await bid(tx, client, b, spot, 6050)).toEqual({ outcome: "rejected", reason: "not-whole-units", minimum: 6600 });
    });
  });

  it("rolls the pending row and bid back when PayPal refuses to create the subscription", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const { client } = fakeClient();
      const broken: PayPalClient = { ...client, createSubscription: async () => { throw new Error("PayPal is down"); } };
      await expect(
        tx.transaction((sp) => bid(sp as unknown as TestDb, broken, a, citySpotKey(ctx.cityId, null), 6000)),
      ).rejects.toThrow("PayPal is down");
      expect(await bidRows(tx, a.listingId)).toEqual([]);
      expect(await currentFeaturedSubscription(tx, ADMIN_VIEWER, a.listingId)).toBeNull();
    });
  });
});

describe("three bidders, every transition", () => {
  it("keeps every listing's quantity equal to the sum of its featured positions", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T09:00:00Z"));
      const ctx = await makeScaffold(tx);
      const spot = citySpotKey(ctx.cityId, null);
      const a = await makeBidder(tx, ctx, "Alpha");
      const b = await makeBidder(tx, ctx, "Bravo");
      const c = await makeBidder(tx, ctx, "Charlie");
      const d = await makeBidder(tx, ctx, "Delta");
      const all = [a, b, c, d];
      const { client, calls } = fakeClient();

      // 1. Alpha's first bid: subscription created with the bid as quantity,
      //    bid pending, nothing featured yet.
      const first = await bid(tx, client, a, spot, 6000);
      expect(first).toMatchObject({ outcome: "approval", approveUrl: "https://paypal.test/approve/1" });
      expect(calls.created).toEqual([{ customId: expect.any(String), quantity: 60, planId: "P-F" }]);
      expect(await board(tx, ctx.cityId)).toEqual([]);
      expect(await bidRows(tx, a.listingId)).toEqual([{ amount: 6000, pending: null, status: "pending", position: null }]);

      // 2. PayPal confirms: Alpha is featured, first, at the confirmed quantity.
      expect((await confirm(tx, client, a)).outcome).toBe("applied");
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha"]);
      expect((await quantities(tx, all)).Alpha).toEqual({ requested: 60, confirmed: 60, status: "active" });
      expect(calls.revised).toEqual([]);

      // 3. Bravo enters at the floor — a free position needs no increment.
      expect((await bid(tx, client, b, spot, 5000)).outcome).toBe("approval");
      await confirm(tx, client, b);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha", "2:Bravo"]);

      // 4. Charlie takes first with the increment. Nobody else's quantity moves.
      expect((await bid(tx, client, c, spot, 7000)).outcome).toBe("approval");
      await confirm(tx, client, c);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Charlie", "2:Alpha", "3:Bravo"]);
      expect(calls.revised).toEqual([]);
      const q4 = await quantities(tx, all);
      expect([q4.Alpha!.confirmed, q4.Bravo!.confirmed, q4.Charlie!.confirmed]).toEqual([60, 50, 70]);

      // 5. A fourth bidder enters above Bravo: Bravo is outbid, holds nothing
      //    featured, and is charged for nothing — the subscription is
      //    cancelled at PayPal rather than left billing.
      expect((await bid(tx, client, d, spot, 6500)).outcome).toBe("approval");
      await confirm(tx, client, d);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Charlie", "2:Delta", "3:Alpha"]);
      const q5 = await quantities(tx, all);
      expect(q5.Bravo).toEqual({ requested: 0, confirmed: 50, status: "cancelled" });
      expect(calls.cancelled).toEqual(["I-F2"]);
      expect((await bidRows(tx, b.listingId)).map((r) => r.status)).toEqual(["cancelled"]);
      expect(calls.revised).toEqual([]);

      // 6. Alpha raises: pending until PayPal confirms the revised quantity.
      //    Alpha keeps position 3 at 6000 meanwhile.
      const raise = await bid(tx, client, a, spot, 8000);
      expect(raise).toMatchObject({ outcome: "approval", approveUrl: "https://paypal.test/revise/I-F1/80" });
      expect(calls.revised).toEqual([{ id: "I-F1", quantity: 80 }]);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Charlie", "2:Delta", "3:Alpha"]);
      expect(await bidRows(tx, a.listingId)).toEqual([{ amount: 6000, pending: 8000, status: "active", position: 3 }]);
      expect((await quantities(tx, all)).Alpha).toEqual({ requested: 60, confirmed: 60, status: "active" });

      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.UPDATED", 80);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha", "2:Charlie", "3:Delta"]);
      expect((await quantities(tx, all)).Alpha).toEqual({ requested: 80, confirmed: 80, status: "active" });

      // 7. Alpha lowers: takes effect at once, and the lower quantity is
      //    requested from PayPal immediately.
      const lower = await bid(tx, client, a, spot, 5100);
      expect(lower).toMatchObject({ outcome: "applied", approveUrl: "https://paypal.test/revise/I-F1/51" });
      expect(await board(tx, ctx.cityId)).toEqual(["1:Charlie", "2:Delta", "3:Alpha"]);
      expect((await quantities(tx, all)).Alpha).toEqual({ requested: 51, confirmed: 80, status: "active" });
      expect(calls.revised.at(-1)).toEqual({ id: "I-F1", quantity: 51 });

      // 8. Charlie cancels the bid: gone now, subscription cancelled at
      //    PayPal, everyone below moves up with no change to their bills.
      const gone = await cancelOwnBid(tx, { client, env: ENV, viewer: c.viewer, profileId: c.profileId, listingId: c.listingId, spotId: (await findSpot(tx, PUBLIC_VIEWER, spot))!.id, ip: null });
      expect(gone.outcome).toBe("applied");
      expect(await board(tx, ctx.cityId)).toEqual(["1:Delta", "2:Alpha"]);
      expect((await quantities(tx, all)).Charlie!.status).toBe("cancelled");
      expect(calls.cancelled).toEqual(["I-F2", "I-F3"]);

      // 9. Delta's subscription lapses at PayPal: every bid Delta held goes.
      expect((await lapse(tx, client, d)).outcome).toBe("applied");
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha"]);
      expect((await bidRows(tx, d.listingId)).map((r) => r.status)).toEqual(["cancelled"]);
      expect((await quantities(tx, all)).Delta!.status).toBe("cancelled");
      // Alpha's bill is still exactly Alpha's one featured bid.
      expect((await quantities(tx, all)).Alpha).toEqual({ requested: 51, confirmed: 80, status: "active" });

      // Nothing here ever touched listings.tier.
      for (const w of all) {
        const [row] = await tx.select({ tier: listings.tier }).from(listings).where(eq(listings.id, w.listingId));
        expect(row!.tier).toBe("premium");
      }
    });
  });

  it("bills one subscription for a listing featured in two spots, and revises when either changes", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const b = await makeBidder(tx, ctx, "Bravo");
      const { client, calls } = fakeClient();
      const citySpot = citySpotKey(ctx.cityId, null);
      const catSpot = citySpotKey(ctx.cityId, ctx.primaryCategoryId);

      await bid(tx, client, a, citySpot, 6000);
      await confirm(tx, client, a);
      // Second spot rides on the existing subscription: a revise, not a create.
      const second = await bid(tx, client, a, catSpot, 5000);
      expect(second.outcome).toBe("approval");
      expect(calls.created).toHaveLength(1);
      expect(calls.revised).toEqual([{ id: "I-F1", quantity: 110 }]);
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.UPDATED", 110);
      expect((await quantities(tx, [a])).Alpha).toEqual({ requested: 110, confirmed: 110, status: "active" });
      expect(await featuredForScope(tx, PUBLIC_VIEWER, { type: "city-category", cityId: ctx.cityId, categoryId: ctx.primaryCategoryId })).toHaveLength(1);

      // Bravo pushes Alpha out of the category spot only: Alpha's quantity
      // drops to the city bid alone, the subscription stays.
      for (let i = 0; i < 3; i++) {
        const w = await makeBidder(tx, ctx, `Filler${i}`);
        await bid(tx, client, w, catSpot, 7000);
        await confirm(tx, client, w);
      }
      expect((await bidRows(tx, a.listingId)).find((r) => r.amount === 5000)).toMatchObject({ status: "outbid", position: null });
      expect((await quantities(tx, [a, b])).Alpha).toEqual({ requested: 60, confirmed: 110, status: "active" });
      expect(calls.revised.at(-1)).toEqual({ id: "I-F1", quantity: 60 });
      expect(calls.cancelled).toEqual([]);
    });
  });

  it("does not ask PayPal for anything while the first approval is still outstanding", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const { client, calls } = fakeClient();
      const first = await bid(tx, client, a, citySpotKey(ctx.cityId, null), 6000);
      const again = await bid(tx, client, a, citySpotKey(ctx.cityId, ctx.primaryCategoryId), 5000);
      expect(again).toMatchObject({ outcome: "approval", approveUrl: (first as { approveUrl: string }).approveUrl });
      expect(calls.created).toHaveLength(1);
      expect(calls.revised).toEqual([]);
      // Both bids ride on the one confirmation.
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.ACTIVATED", 110);
      expect((await bidRows(tx, a.listingId)).map((r) => r.status)).toEqual(["active", "active"]);
      expect((await quantities(tx, [a])).Alpha).toEqual({ requested: 110, confirmed: 110, status: "active" });
    });
  });

  it("re-requests the revision when PayPal confirms a quantity that no longer matches", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const { client, calls } = fakeClient();
      await bid(tx, client, a, citySpotKey(ctx.cityId, null), 6000);
      // PayPal says 60 was approved but the ranking now needs 60 — fine —
      // then a stale UPDATED arrives claiming 40.
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.ACTIVATED", 60);
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.UPDATED", 40);
      expect((await quantities(tx, [a])).Alpha).toEqual({ requested: 60, confirmed: 40, status: "active" });
      expect(calls.revised.at(-1)).toEqual({ id: "I-F1", quantity: 60 });
    });
  });
});

describe("through the shared webhook endpoint", () => {
  const HEADERS = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/c.pem",
    "paypal-transmission-id": "t",
    "paypal-transmission-sig": "s",
    "paypal-transmission-time": "2026-09-12T09:00:00Z",
  };

  it("applies a featured ACTIVATED once, marks the redelivery a duplicate, and hands back the spot's paths", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const { client } = fakeClient();
      await bid(tx, client, a, citySpotKey(ctx.cityId, null), 6000);
      const sub = (await currentFeaturedSubscription(tx, ADMIN_VIEWER, a.listingId))!;
      const raw = JSON.stringify({
        id: "WH-FEATURED-1",
        event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
        create_time: "2026-09-22T09:00:00Z",
        resource: { id: sub.providerSubscriptionId, custom_id: sub.id, status: "ACTIVE", plan_id: "P-F", quantity: "60", billing_info: { next_billing_time: "2026-10-22T09:00:00Z" } },
      });
      const first = await processPayPalWebhook(tx, { raw, headers: HEADERS, client, env: ENV });
      expect(first).toMatchObject({ status: 200, outcome: "applied", detail: "featured.confirm" });
      expect(first.revalidate?.paths).toEqual([expect.stringMatching(/^\/[a-z0-9-]+$/)]);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha"]);

      // A raise in between would be confirmed by a replay; the unique index says no.
      await bid(tx, client, a, citySpotKey(ctx.cityId, null), 9000);
      const again = await processPayPalWebhook(tx, { raw, headers: HEADERS, client, env: ENV });
      expect(again.outcome).toBe("duplicate");
      expect(await bidRows(tx, a.listingId)).toEqual([{ amount: 6000, pending: 9000, status: "active", position: 1 }]);
    });
  });

  it("still answers unknown-subscription for an id neither table holds", async () => {
    await withTestDb(async (tx) => {
      const { client } = fakeClient();
      const raw = JSON.stringify({
        id: "WH-NOBODY",
        event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
        resource: { id: "I-NOBODY", status: "ACTIVE" },
      });
      const out = await processPayPalWebhook(tx, { raw, headers: HEADERS, client, env: ENV });
      expect(out.outcome).toBe("unknown-subscription");
    });
  });

  it("takes every bid away on SUSPENDED and EXPIRED too, and only notes a failed payment", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const { client } = fakeClient();
      await bid(tx, client, a, citySpotKey(ctx.cityId, null), 6000);
      await confirm(tx, client, a);

      const sub = (await currentFeaturedSubscription(tx, ADMIN_VIEWER, a.listingId))!;
      const failed = parseEvent({
        id: "WH-PF", event_type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
        resource: { id: sub.providerSubscriptionId, custom_id: sub.id },
      }) as PayPalEvent;
      expect((await processFeaturedEvent(tx, { event: failed, client, env: ENV })).outcome).toBe("applied");
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha"]);
      expect((await currentFeaturedSubscription(tx, ADMIN_VIEWER, a.listingId))?.status).toBe("past_due");

      expect((await lapse(tx, client, a, "BILLING.SUBSCRIPTION.SUSPENDED")).outcome).toBe("applied");
      expect(await board(tx, ctx.cityId)).toEqual([]);
      expect(await spotBids(tx, PUBLIC_VIEWER, (await findSpot(tx, PUBLIC_VIEWER, citySpotKey(ctx.cityId, null)))!.id)).toEqual([]);
    });
  });
});
