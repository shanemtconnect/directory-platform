import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import {
  auditLog,
  categories,
  cities,
  featuredBids,
  featuredSpots,
  featuredSubscriptions,
  listings,
  profiles,
  slugs,
  subscriptions,
  user,
  verticals,
} from "@/lib/db/schema";
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
import type { PayPalClient, PayPalSubscriptionView } from "@/lib/billing/paypal";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { cancelOwnBid, placeBid } from "./bidding";
import { processFeaturedEvent, reconcileFeaturedSubscription } from "./webhook";
import { parseEvent, type PayPalEvent } from "@/lib/billing/webhooks";

const ENV = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", PAYPAL_WEBHOOK_ID: "WH", PAYPAL_PLAN_FEATURED: "P-F" };

afterEach(() => resetClock());

/* ------------------------------------------------------------- fake PayPal */

interface Calls {
  created: { customId: string; quantity: number | null | undefined; planId: string }[];
  revised: { id: string; quantity: number }[];
  cancelled: string[];
  suspended: string[];
  activated: string[];
}

function fakeClient(opts: { view?: PayPalSubscriptionView | null; delayCreateMs?: number } = {}): { client: PayPalClient; calls: Calls } {
  const calls: Calls = { created: [], revised: [], cancelled: [], suspended: [], activated: [] };
  let n = 0;
  const client: PayPalClient = {
    createSubscription: async (input) => {
      if (opts.delayCreateMs) await new Promise((r) => setTimeout(r, opts.delayCreateMs));
      calls.created.push({ customId: input.customId, quantity: input.quantity, planId: input.planId });
      n++;
      return { id: `I-F${n}`, status: "APPROVAL_PENDING", approveUrl: `https://paypal.test/approve/${n}` };
    },
    getSubscription: async () => opts.view ?? null,
    cancelSubscription: async (id) => {
      calls.cancelled.push(id);
    },
    suspendSubscription: async (id) => {
      calls.suspended.push(id);
    },
    activateSubscription: async (id) => {
      calls.activated.push(id);
    },
    manageUrl: async () => null,
    verifyWebhookSignature: async () => true,
    reviseSubscription: async (id, input) => {
      calls.revised.push({ id, quantity: input.quantity });
      return { approveUrl: `https://paypal.test/revise/${id}/${input.quantity}` };
    },
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

/**
 * PayPal's confirmation for the listing's featured subscription, carrying an
 * explicit quantity (`null` = a payload without one). Defaults to exactly what
 * was asked — the "buyer approved as asked" case.
 */
async function confirm(
  tx: TestDb,
  client: PayPalClient,
  who: Bidder,
  type = "BILLING.SUBSCRIPTION.ACTIVATED",
  quantity?: number | null,
) {
  const [sub] = await tx
    .select({ id: featuredSubscriptions.id, providerSubscriptionId: featuredSubscriptions.providerSubscriptionId, requested: featuredSubscriptions.requestedQuantity })
    .from(featuredSubscriptions)
    .where(eq(featuredSubscriptions.listingId, who.listingId))
    .orderBy(featuredSubscriptions.createdAt);
  if (!sub) throw new Error("no featured subscription to confirm");
  const q = quantity === undefined ? sub.requested : quantity;
  const event = parseEvent({
    id: `WH-${randomUUID()}`,
    event_type: type,
    create_time: "2026-09-22T09:00:00Z",
    resource: {
      id: sub.providerSubscriptionId,
      custom_id: sub.id,
      status: "ACTIVE",
      plan_id: "P-F",
      ...(q === null ? {} : { quantity: String(q) }),
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

interface Q { requested: number; confirmed: number; status: string; approveUrl: string | null }

async function quantities(tx: TestDb, who: Bidder[]): Promise<Record<string, Q | null>> {
  const out: Record<string, Q | null> = {};
  for (const w of who) {
    const [row] = await tx
      .select({ requested: featuredSubscriptions.requestedQuantity, confirmed: featuredSubscriptions.quantity, status: featuredSubscriptions.status, approveUrl: featuredSubscriptions.approveUrl })
      .from(featuredSubscriptions)
      .where(eq(featuredSubscriptions.listingId, w.listingId))
      .orderBy(featuredSubscriptions.createdAt);
    out[w.name] = row ?? null;
  }
  return out;
}

const q = (requested: number, confirmed: number, status: string) => expect.objectContaining({ requested, confirmed, status });

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
      expect(await bid(tx, client, free, citySpotKey(ctx.cityId, null), 6000)).toEqual({ outcome: "not-eligible", reason: "no-subscription" });
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

describe("four bidders, every transition", () => {
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

      // 2. PayPal confirms 60: Alpha is featured, first.
      expect((await confirm(tx, client, a)).outcome).toBe("applied");
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha"]);
      expect((await quantities(tx, all)).Alpha).toEqual(q(60, 60, "active"));
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

      // 5. A fourth bidder enters above Bravo: Bravo is OUTBID — the bid
      //    stays in the queue, the subscription is suspended at PayPal (no
      //    consent needed) and charges nothing.
      expect((await bid(tx, client, d, spot, 6500)).outcome).toBe("approval");
      await confirm(tx, client, d);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Charlie", "2:Delta", "3:Alpha"]);
      expect((await quantities(tx, all)).Bravo).toEqual(q(50, 50, "paused"));
      expect(calls.suspended).toEqual(["I-F2"]);
      expect(calls.cancelled).toEqual([]);
      expect(await bidRows(tx, b.listingId)).toEqual([{ amount: 5000, pending: null, status: "outbid", position: null }]);
      expect(calls.revised).toEqual([]);

      // 6. Alpha raises: pending until PayPal confirms the revised quantity,
      //    which is recorded as what was ASKED. Alpha keeps #3 at 6000.
      const raise = await bid(tx, client, a, spot, 8000);
      expect(raise).toMatchObject({ outcome: "approval", approveUrl: "https://paypal.test/revise/I-F1/80" });
      expect(calls.revised).toEqual([{ id: "I-F1", quantity: 80 }]);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Charlie", "2:Delta", "3:Alpha"]);
      expect(await bidRows(tx, a.listingId)).toEqual([{ amount: 6000, pending: 8000, status: "active", position: 3 }]);
      expect((await quantities(tx, all)).Alpha).toEqual(q(80, 60, "active"));

      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.UPDATED", 80);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha", "2:Charlie", "3:Delta"]);
      expect((await quantities(tx, all)).Alpha).toEqual(q(80, 80, "active"));

      // 7. Alpha lowers: takes effect at once, and the lower quantity is
      //    asked of PayPal immediately.
      const lower = await bid(tx, client, a, spot, 5100);
      expect(lower).toMatchObject({ outcome: "applied", approveUrl: "https://paypal.test/revise/I-F1/51" });
      expect(await board(tx, ctx.cityId)).toEqual(["1:Charlie", "2:Delta", "3:Alpha"]);
      expect((await quantities(tx, all)).Alpha).toEqual(q(51, 80, "active"));
      expect(calls.revised.at(-1)).toEqual({ id: "I-F1", quantity: 51 });

      // 8. Charlie cancels the bid: gone now, and with no bid left at all the
      //    subscription is CANCELLED at PayPal (Task 45 I3 — nothing can
      //    re-enter, so not paused); Bravo's outbid bid re-enters at #3 and
      //    its subscription is RE-ACTIVATED at the quantity already consented
      //    to — no approval, no revise.
      const gone = await cancelOwnBid(tx, { client, env: ENV, viewer: c.viewer, profileId: c.profileId, listingId: c.listingId, spotId: (await findSpot(tx, PUBLIC_VIEWER, spot))!.id, ip: null });
      expect(gone).toMatchObject({ outcome: "applied", approveUrl: null });
      expect(await board(tx, ctx.cityId)).toEqual(["1:Delta", "2:Alpha", "3:Bravo"]);
      expect((await quantities(tx, all)).Charlie).toEqual(q(70, 70, "cancelled"));
      expect((await quantities(tx, all)).Bravo).toEqual(q(50, 50, "active"));
      expect(calls.suspended).toEqual(["I-F2"]);
      expect(calls.cancelled).toEqual(["I-F3"]);
      expect(calls.activated).toEqual(["I-F2"]);
      expect(calls.created).toHaveLength(4);
      expect(calls.revised.at(-1)).toEqual({ id: "I-F1", quantity: 51 });

      // 9. Delta's subscription lapses at PayPal: every bid Delta held goes.
      expect((await lapse(tx, client, d)).outcome).toBe("applied");
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha", "2:Bravo"]);
      expect((await bidRows(tx, d.listingId)).map((r) => r.status)).toEqual(["cancelled"]);
      expect((await quantities(tx, all)).Delta!.status).toBe("cancelled");
      expect((await quantities(tx, all)).Alpha).toEqual(q(51, 80, "active"));

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
      expect((await quantities(tx, [a])).Alpha).toEqual(q(110, 60, "active"));
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.UPDATED", 110);
      expect((await quantities(tx, [a])).Alpha).toEqual(q(110, 110, "active"));
      expect(await featuredForScope(tx, PUBLIC_VIEWER, { type: "city-category", cityId: ctx.cityId, categoryId: ctx.primaryCategoryId })).toHaveLength(1);

      // Three others push Alpha out of the category spot only: Alpha's
      // quantity drops to the city bid alone; the subscription stays active.
      for (let i = 0; i < 3; i++) {
        const w = await makeBidder(tx, ctx, `Filler${i}`);
        await bid(tx, client, w, catSpot, 7000);
        await confirm(tx, client, w);
      }
      expect((await bidRows(tx, a.listingId)).find((r) => r.amount === 5000)).toMatchObject({ status: "outbid", position: null });
      expect((await quantities(tx, [a])).Alpha).toEqual(q(60, 110, "active"));
      expect(calls.revised.at(-1)).toEqual({ id: "I-F1", quantity: 60 });
      expect(calls.suspended).toEqual([]);
      expect(calls.cancelled).toEqual([]);
    });
  });

  it("refuses a second bid while the first approval is outstanding, and sends the owner back to it", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const { client, calls } = fakeClient();
      const first = await bid(tx, client, a, citySpotKey(ctx.cityId, null), 6000);
      const again = await bid(tx, client, a, citySpotKey(ctx.cityId, ctx.primaryCategoryId), 5000);
      expect(again).toEqual({ outcome: "awaiting-approval", approveUrl: (first as { approveUrl: string }).approveUrl });
      expect(calls.created).toHaveLength(1);
      expect(calls.revised).toEqual([]);
      expect(await bidRows(tx, a.listingId)).toHaveLength(1);
    });
  });

  it("re-requests the revision when PayPal confirms a quantity that no longer matches", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const { client, calls } = fakeClient();
      await bid(tx, client, a, citySpotKey(ctx.cityId, null), 6000);
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.ACTIVATED", 60);
      // A stale UPDATED claiming 40: the bill is 40, the bid needs 60.
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.UPDATED", 40);
      expect((await quantities(tx, [a])).Alpha).toEqual(q(60, 40, "active"));
      expect(calls.revised.at(-1)).toEqual({ id: "I-F1", quantity: 60 });
    });
  });
});

describe("C1 — a pending bid becomes money only on evidence", () => {
  async function raised(tx: TestDb) {
    const ctx = await makeScaffold(tx);
    const a = await makeBidder(tx, ctx, "Alpha");
    const { client, calls } = fakeClient();
    await bid(tx, client, a, citySpotKey(ctx.cityId, null), 6000);
    await confirm(tx, client, a, "BILLING.SUBSCRIPTION.ACTIVATED", 60);
    const raise = await bid(tx, client, a, citySpotKey(ctx.cityId, null), 8000);
    expect(raise.outcome).toBe("approval");
    expect((await quantities(tx, [a])).Alpha).toEqual(q(80, 60, "active"));
    return { ctx, a, client, calls };
  }

  it("a pending raise + PAYMENT.SALE.COMPLETED: the raise stays pending, the quantity stays 60", async () => {
    await withTestDb(async (tx) => {
      const { ctx, a, client, calls } = await raised(tx);
      const sub = (await currentFeaturedSubscription(tx, ADMIN_VIEWER, a.listingId))!;
      const sale = parseEvent({
        id: "WH-SALE-1",
        event_type: "PAYMENT.SALE.COMPLETED",
        resource: { billing_agreement_id: sub.providerSubscriptionId, amount: { total: "60.00" } },
      }) as PayPalEvent;
      const out = await processFeaturedEvent(tx, { event: sale, client, env: ENV });
      expect(out).toMatchObject({ outcome: "applied", action: "renew" });
      expect(await bidRows(tx, a.listingId)).toEqual([{ amount: 6000, pending: 8000, status: "active", position: 1 }]);
      expect((await quantities(tx, [a])).Alpha).toEqual(expect.objectContaining({ requested: 80, confirmed: 60, approveUrl: "https://paypal.test/revise/I-F1/80" }));
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha"]);
      expect(calls.revised).toEqual([{ id: "I-F1", quantity: 80 }]);
    });
  });

  it("a pending raise + UPDATED with a LOWER quantity: not confirmed, the bill is what PayPal said", async () => {
    await withTestDb(async (tx) => {
      const { a, client, calls } = await raised(tx);
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.UPDATED", 70);
      expect(await bidRows(tx, a.listingId)).toEqual([{ amount: 6000, pending: 8000, status: "active", position: 1 }]);
      expect((await quantities(tx, [a])).Alpha).toEqual(expect.objectContaining({ requested: 80, confirmed: 70, approveUrl: "https://paypal.test/revise/I-F1/80" }));
      // Not asked again underneath the outstanding request.
      expect(calls.revised).toEqual([{ id: "I-F1", quantity: 80 }]);

      // The click lands: 80 covers what was asked.
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.UPDATED", 80);
      expect(await bidRows(tx, a.listingId)).toEqual([{ amount: 8000, pending: null, status: "active", position: 1 }]);
      expect((await quantities(tx, [a])).Alpha).toEqual(expect.objectContaining({ requested: 80, confirmed: 80, approveUrl: null }));
    });
  });

  it("an UPDATED or ACTIVATED with no quantity at all confirms nothing and leaves the quantity alone", async () => {
    await withTestDb(async (tx) => {
      const { a, client } = await raised(tx);
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.UPDATED", null);
      expect(await bidRows(tx, a.listingId)).toEqual([{ amount: 6000, pending: 8000, status: "active", position: 1 }]);
      expect((await quantities(tx, [a])).Alpha).toEqual(q(80, 60, "active"));
    });
  });

  it("the hourly reconcile: GET ACTIVE without a quantity does not confirm a pending first bid", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const { client } = fakeClient();
      await bid(tx, client, a, citySpotKey(ctx.cityId, null), 6000);
      const sub = (await currentFeaturedSubscription(tx, ADMIN_VIEWER, a.listingId))!;

      const blind: PayPalClient = { ...client, getSubscription: async () => ({ id: "I-F1", status: "ACTIVE", planId: "P-F", nextBillingTime: "2026-10-22T09:00:00Z", lastPaymentTime: null }) };
      const out = await reconcileFeaturedSubscription(tx, { client: blind, env: ENV, providerSubscriptionId: sub.providerSubscriptionId! });
      expect(out.outcome).toBe("applied");
      expect(await bidRows(tx, a.listingId)).toEqual([{ amount: 6000, pending: null, status: "pending", position: null }]);
      expect((await quantities(tx, [a])).Alpha).toEqual(q(60, 0, "active"));
      expect(await board(tx, ctx.cityId)).toEqual([]);

      // The GET that carries the quantity is the evidence.
      const sighted: PayPalClient = { ...client, getSubscription: async () => ({ id: "I-F1", status: "ACTIVE", planId: "P-F", nextBillingTime: "2026-10-22T09:00:00Z", lastPaymentTime: null, quantity: 60 }) };
      await reconcileFeaturedSubscription(tx, { client: sighted, env: ENV, providerSubscriptionId: sub.providerSubscriptionId! });
      expect(await board(tx, ctx.cityId)).toEqual(["1:Alpha"]);
      expect((await quantities(tx, [a])).Alpha).toEqual(q(60, 60, "active"));
    });
  });
});

describe("I1 — raising to a tie queues behind the leader", () => {
  it("Alpha at 50, Bravo at 60 leads; Alpha raises to 60 and lands second", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T09:00:00Z"));
      const ctx = await makeScaffold(tx);
      const spot = citySpotKey(ctx.cityId, null);
      const a = await makeBidder(tx, ctx, "Alpha");
      const b = await makeBidder(tx, ctx, "Bravo");
      const { client } = fakeClient();
      await bid(tx, client, a, spot, 5000);
      await confirm(tx, client, a);
      setClock(new Date("2026-09-22T10:00:00Z"));
      await bid(tx, client, b, spot, 6000);
      await confirm(tx, client, b);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Bravo", "2:Alpha"]);

      setClock(new Date("2026-09-22T11:00:00Z"));
      // Equal to the top is allowed — it is not taking first.
      expect((await bid(tx, client, a, spot, 6000)).outcome).toBe("approval");
      await confirm(tx, client, a, "BILLING.SUBSCRIPTION.UPDATED", 60);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Bravo", "2:Alpha"]);
    });
  });
});

describe("I5 — outbid keeps the bid; re-entry needs no new approval", () => {
  it("suspends at PayPal when every bid is outbid, and re-activates at the consented quantity when one returns", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const spot = citySpotKey(ctx.cityId, null);
      const { client, calls } = fakeClient();
      const a = await makeBidder(tx, ctx, "Alpha");
      await bid(tx, client, a, spot, 5000);
      await confirm(tx, client, a);
      const fillers: Bidder[] = [];
      for (let i = 0; i < 3; i++) {
        const w = await makeBidder(tx, ctx, `Filler${i}`);
        fillers.push(w);
        await bid(tx, client, w, spot, 7000);
        await confirm(tx, client, w);
      }
      expect(await board(tx, ctx.cityId)).toEqual(["1:Filler0", "2:Filler1", "3:Filler2"]);
      expect(await bidRows(tx, a.listingId)).toEqual([{ amount: 5000, pending: null, status: "outbid", position: null }]);
      expect((await quantities(tx, [a])).Alpha).toEqual(q(50, 50, "paused"));
      expect(calls.suspended).toEqual(["I-F1"]);
      expect(calls.cancelled).toEqual([]);

      // A leader leaves: Alpha is back at #3, billing resumes as consented.
      await lapse(tx, client, fillers[0]!);
      expect(await board(tx, ctx.cityId)).toEqual(["1:Filler1", "2:Filler2", "3:Alpha"]);
      expect((await quantities(tx, [a])).Alpha).toEqual(q(50, 50, "active"));
      expect(calls.activated).toEqual(["I-F1"]);
      expect(calls.created).toHaveLength(4);
      expect(calls.revised.filter((r) => r.id === "I-F1")).toEqual([]);
    });
  });

  it("a paused listing bidding again at its consented amount is confirmed without asking PayPal for approval", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const citySpot = citySpotKey(ctx.cityId, null);
      const catSpot = citySpotKey(ctx.cityId, ctx.primaryCategoryId);
      const { client, calls } = fakeClient();
      const a = await makeBidder(tx, ctx, "Alpha");
      await bid(tx, client, a, citySpot, 5000);
      await confirm(tx, client, a);
      for (let i = 0; i < 3; i++) {
        const w = await makeBidder(tx, ctx, `Filler${i}`);
        await bid(tx, client, w, citySpot, 7000);
        await confirm(tx, client, w);
      }
      expect((await quantities(tx, [a])).Alpha).toEqual(q(50, 50, "paused"));

      // Same 50 on the category spot: activate, no revise, featured at once.
      const out = await bid(tx, client, a, catSpot, 5000);
      expect(out).toMatchObject({ outcome: "applied", approveUrl: null });
      expect(calls.activated).toEqual(["I-F1"]);
      expect(calls.revised.filter((r) => r.id === "I-F1")).toEqual([]);
      expect(await featuredForScope(tx, PUBLIC_VIEWER, { type: "city-category", cityId: ctx.cityId, categoryId: ctx.primaryCategoryId })).toHaveLength(1);
      expect((await quantities(tx, [a])).Alpha).toEqual(q(50, 50, "active"));
    });
  });
});

describe("I7 — a late confirm after a lapse is ignored", () => {
  it("CANCELLED, then a delayed ACTIVATED: the row stays cancelled and no bid comes back", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, "Alpha");
      const { client } = fakeClient();
      await bid(tx, client, a, citySpotKey(ctx.cityId, null), 6000);
      await confirm(tx, client, a);
      await lapse(tx, client, a);
      const late = await confirm(tx, client, a, "BILLING.SUBSCRIPTION.ACTIVATED", 60);
      expect(late).toEqual({ outcome: "ignored", reason: "row is cancelled" });
      const [row] = await tx.select({ status: featuredSubscriptions.status }).from(featuredSubscriptions).where(eq(featuredSubscriptions.listingId, a.listingId));
      expect(row!.status).toBe("cancelled");
      expect((await bidRows(tx, a.listingId)).map((r) => r.status)).toEqual(["cancelled"]);
      expect(await board(tx, ctx.cityId)).toEqual([]);
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

  it("takes every bid away on PayPal's SUSPENDED, only notes a failed payment, and ignores the echo of its own pause", async () => {
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

      // Our own pause, echoed back by PayPal: not a lapse.
      await tx.update(featuredSubscriptions).set({ status: "paused" }).where(eq(featuredSubscriptions.id, sub.id));
      expect(await lapse(tx, client, a, "BILLING.SUBSCRIPTION.SUSPENDED")).toEqual({ outcome: "ignored", reason: "suspended by this site (paused)" });
      await tx.update(featuredSubscriptions).set({ status: "active" }).where(eq(featuredSubscriptions.id, sub.id));

      expect((await lapse(tx, client, a, "BILLING.SUBSCRIPTION.SUSPENDED")).outcome).toBe("applied");
      expect(await board(tx, ctx.cityId)).toEqual([]);
      expect(await spotBids(tx, PUBLIC_VIEWER, (await findSpot(tx, PUBLIC_VIEWER, citySpotKey(ctx.cityId, null)))!.id)).toEqual([]);
    });
  });
});

describe("I8 — two first bids at once", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
  const conn = postgres(url, { max: 4 });
  const database = drizzle(conn, { schema });
  const stamp = randomUUID();
  const userId = `u_${stamp}`;
  const ids = { vertical: "", city: "", category: "", listing: "", profile: "" };

  afterAll(async () => {
    if (ids.listing !== "") {
      const subs = await database.select({ id: featuredSubscriptions.id }).from(featuredSubscriptions).where(eq(featuredSubscriptions.listingId, ids.listing));
      const bids = await database.select({ id: featuredBids.id }).from(featuredBids).where(eq(featuredBids.listingId, ids.listing));
      const entityIds = [...subs, ...bids].map((r) => r.id);
      if (entityIds.length > 0) await database.delete(auditLog).where(inArray(auditLog.entityId, entityIds));
      await database.delete(featuredBids).where(eq(featuredBids.listingId, ids.listing));
      await database.delete(featuredSubscriptions).where(eq(featuredSubscriptions.listingId, ids.listing));
      await database.delete(featuredSpots).where(eq(featuredSpots.areaId, ids.city));
      const tier = await database.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.listingId, ids.listing));
      if (tier.length > 0) await database.delete(auditLog).where(inArray(auditLog.entityId, tier.map((s) => s.id)));
      await database.delete(subscriptions).where(eq(subscriptions.listingId, ids.listing));
      await database.delete(listings).where(eq(listings.id, ids.listing));
    }
    const owned = [ids.listing, ids.category, ids.city, ids.vertical].filter((v) => v !== "");
    if (owned.length > 0) await database.delete(slugs).where(inArray(slugs.entityId, owned));
    if (ids.city !== "") await database.delete(cities).where(eq(cities.id, ids.city));
    if (ids.category !== "") await database.delete(categories).where(eq(categories.id, ids.category));
    if (ids.vertical !== "") await database.delete(verticals).where(eq(verticals.id, ids.vertical));
    await database.delete(profiles).where(eq(profiles.userId, userId));
    await database.delete(user).where(eq(user.id, userId));
    await conn.end({ timeout: 5 });
  });

  it("serialise on the listing: one PayPal subscription, the second bid told to finish the first approval", async () => {
    const db = database as unknown as TestDb;
    const ctx = await makeScaffold(db);
    ids.vertical = ctx.verticalId;
    ids.city = ctx.cityId;
    ids.category = ctx.primaryCategoryId;
    await database.insert(user).values({ id: userId, name: "O", email: `${userId}@example.test` });
    const viewer = { role: "user" as const, userId };
    const { id: profileId } = await ensureProfile(db, viewer);
    ids.profile = profileId;
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
