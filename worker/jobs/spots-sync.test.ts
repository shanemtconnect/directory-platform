import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { featuredBids, featuredSubscriptions, subscriptions, user } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { ensureProfile } from "@/lib/auth/profile";
import { resetClock, setClock } from "@/lib/clock";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { createPendingSubscription } from "@/lib/db/queries/billing";
import { auditLog } from "@/lib/db/schema";
import { citySpotKey, currentFeaturedSubscription, featuredForScope, RAISE_EXPIRED_ACTION } from "@/lib/db/queries/spots";
import type { PayPalClient, PayPalSubscriptionView } from "@/lib/billing/paypal";
import { placeBid } from "@/lib/spots/bidding";
import { processFeaturedEvent } from "@/lib/spots/webhook";
import { parseEvent, type PayPalEvent } from "@/lib/billing/webhooks";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { syncFeaturedSubscriptions } from "./spots-sync";

const ENV = { PAYPAL_PLAN_FEATURED: "P-F" };

afterEach(() => resetClock());

function client(view: PayPalSubscriptionView | null | "throw", revised: number[] = [], cancelled: string[] = []): PayPalClient {
  return {
    createSubscription: async () => ({ id: "I-FS", status: "APPROVAL_PENDING", approveUrl: "https://paypal.test/a" }),
    getSubscription: async () => {
      if (view === "throw") throw new Error("PayPal is down");
      return view;
    },
    cancelSubscription: async (id) => {
      cancelled.push(id);
    },
    suspendSubscription: async () => {},
    activateSubscription: async () => {},
    manageUrl: async () => null,
    verifyWebhookSignature: async () => true,
    reviseSubscription: async (_id, input) => {
      revised.push(input.quantity);
      return { approveUrl: "https://paypal.test/revise" };
    },
  };
}

/** A confirmed featured bid of 60 on the city spot, period ending 12 Oct. */
async function activeRow(tx: TestDb) {
  setClock(new Date("2026-09-12T09:00:00Z"));
  const ctx = await makeScaffold(tx);
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "O", email: `${userId}@example.test` });
  const viewer = { role: "user" as const, userId };
  const { id: profileId } = await ensureProfile(tx, viewer);
  const listingId = await makeListing(tx, ctx, { ownerId: profileId, claimStatus: "verified", tier: "premium" });
  const tierSub = await createPendingSubscription(tx, viewer, {
    listingId, profileId, tier: "premium", interval: "monthly", providerPlanId: "P-1", ip: null,
  });
  await tx.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.id, tierSub));

  const c = client(null);
  const out = await placeBid(tx, { client: c, env: ENV, viewer, profileId, listingId, spot: citySpotKey(ctx.cityId, null), amountCents: 6000, ip: null });
  if (out.outcome !== "approval") throw new Error(`bid was ${out.outcome}`);
  const sub = (await currentFeaturedSubscription(tx, ADMIN_VIEWER, listingId))!;
  return { ctx, listingId, sub, viewer, profileId };
}

async function confirmed(tx: TestDb) {
  const s = await activeRow(tx);
  const event = parseEvent({
    id: `WH-${randomUUID()}`,
    event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
    resource: { id: s.sub.providerSubscriptionId, custom_id: s.sub.id, status: "ACTIVE", quantity: "60", billing_info: { next_billing_time: "2026-10-12T09:00:00Z" } },
  }) as PayPalEvent;
  await processFeaturedEvent(tx, { event, client: client(null), env: ENV });
  return s;
}

async function subRow(tx: TestDb, id: string) {
  const [row] = await tx
    .select({ status: featuredSubscriptions.status, quantity: featuredSubscriptions.quantity, requested: featuredSubscriptions.requestedQuantity })
    .from(featuredSubscriptions)
    .where(eq(featuredSubscriptions.id, id));
  return row!;
}

describe("syncFeaturedSubscriptions", () => {
  it("does nothing at all when PayPal is not configured", async () => {
    await withTestDb(async (tx) => {
      const s = await confirmed(tx);
      setClock(new Date("2026-10-20T00:00:00Z"));
      const out = await syncFeaturedSubscriptions(tx, { client: null, env: ENV });
      expect(out).toEqual({ checked: 0, reconciled: 0, expired: 0, cancelled: 0, skipped: true, revalidate: [] });
      expect((await subRow(tx, s.sub.id)).status).toBe("active");
    });
  });

  it("leaves a row alone inside the grace period, and when nothing is out of step", async () => {
    await withTestDb(async (tx) => {
      await confirmed(tx);
      setClock(new Date("2026-10-14T00:00:00Z"));
      const out = await syncFeaturedSubscriptions(tx, { client: client(null), env: ENV });
      expect(out.checked).toBe(0);
    });
  });

  it("lapses a row PayPal has cancelled: every bid goes, and the spot's page is handed back", async () => {
    await withTestDb(async (tx) => {
      const s = await confirmed(tx);
      setClock(new Date("2026-10-20T00:00:00Z"));
      const out = await syncFeaturedSubscriptions(tx, {
        client: client({ id: "I-FS", status: "CANCELLED", planId: "P-F", nextBillingTime: null, lastPaymentTime: null }),
        env: ENV,
      });
      expect(out.checked).toBe(1);
      expect(out.reconciled).toBe(1);
      expect(out.revalidate).toEqual([expect.stringMatching(/^\/[a-z0-9-]+$/)]);
      expect((await subRow(tx, s.sub.id)).status).toBe("cancelled");
      expect(await featuredForScope(tx, PUBLIC_VIEWER, { type: "city", cityId: s.ctx.cityId })).toEqual([]);
    });
  });

  it("re-requests the revision when PayPal's quantity is not what the bids need", async () => {
    await withTestDb(async (tx) => {
      const s = await confirmed(tx);
      // The owner lowered to 40; PayPal still says 60 and the buyer never approved.
      await tx.update(featuredBids).set({ amountCents: 4000 }).where(eq(featuredBids.listingId, s.listingId));
      await tx.update(featuredSubscriptions).set({ requestedQuantity: 40 }).where(eq(featuredSubscriptions.id, s.sub.id));
      setClock(new Date("2026-09-13T00:00:00Z"));
      const revised: number[] = [];
      const out = await syncFeaturedSubscriptions(tx, {
        client: client({ id: "I-FS", status: "ACTIVE", planId: "P-F", nextBillingTime: "2026-10-12T09:00:00Z", lastPaymentTime: null, quantity: 60 }, revised),
        env: ENV,
      });
      expect(out.checked).toBe(1);
      expect(revised).toEqual([40]);
      expect(await subRow(tx, s.sub.id)).toEqual({ status: "active", quantity: 60, requested: 40 });
    });
  });

  it("changes nothing when PayPal is unreachable", async () => {
    await withTestDb(async (tx) => {
      const s = await confirmed(tx);
      setClock(new Date("2026-10-20T00:00:00Z"));
      const out = await syncFeaturedSubscriptions(tx, { client: client("throw"), env: ENV });
      expect(out).toMatchObject({ checked: 1, reconciled: 0, expired: 0, revalidate: [] });
      expect((await subRow(tx, s.sub.id)).status).toBe("active");
      expect(await featuredForScope(tx, PUBLIC_VIEWER, { type: "city", cityId: s.ctx.cityId })).toHaveLength(1);
    });
  });

  it("expires an approval nobody completed after a day, cancelling its pending bids", async () => {
    await withTestDb(async (tx) => {
      const s = await activeRow(tx);
      setClock(new Date("2026-09-13T10:00:00Z"));
      const out = await syncFeaturedSubscriptions(tx, {
        client: client({ id: "I-FS", status: "APPROVAL_PENDING", planId: "P-F", nextBillingTime: null, lastPaymentTime: null }),
        env: ENV,
      });
      expect(out).toMatchObject({ checked: 1, expired: 1, reconciled: 0 });
      expect((await subRow(tx, s.sub.id)).status).toBe("expired");
      const [bid] = await tx.select({ status: featuredBids.status }).from(featuredBids).where(eq(featuredBids.listingId, s.listingId));
      expect(bid!.status).toBe("cancelled");
    });
  });

  it("activates an approval the webhook missed, instead of expiring it", async () => {
    await withTestDb(async (tx) => {
      const s = await activeRow(tx);
      setClock(new Date("2026-09-13T10:00:00Z"));
      const out = await syncFeaturedSubscriptions(tx, {
        client: client({ id: "I-FS", status: "ACTIVE", planId: "P-F", nextBillingTime: "2026-10-12T09:00:00Z", lastPaymentTime: null, quantity: 60 }),
        env: ENV,
      });
      expect(out).toMatchObject({ checked: 1, expired: 0, reconciled: 1 });
      expect(await subRow(tx, s.sub.id)).toEqual({ status: "active", quantity: 60, requested: 60 });
      expect(await featuredForScope(tx, PUBLIC_VIEWER, { type: "city", cityId: s.ctx.cityId })).toHaveLength(1);
    });
  });

  it("drops a raise nobody approved within a day, tells the audit log, and re-settles the quantity", async () => {
    await withTestDb(async (tx) => {
      const s = await confirmed(tx);
      // A raise to 80: pending amount, revise asked, never approved.
      const revised: number[] = [];
      const raise = await placeBid(tx, { client: client(null, revised), env: ENV, viewer: s.viewer, profileId: s.profileId, listingId: s.listingId, spot: citySpotKey(s.ctx.cityId, null), amountCents: 8000, ip: null });
      expect(raise.outcome).toBe("approval");
      expect(await subRow(tx, s.sub.id)).toEqual({ status: "active", quantity: 60, requested: 80 });

      setClock(new Date("2026-09-13T10:00:00Z"));
      const out = await syncFeaturedSubscriptions(tx, {
        client: client({ id: "I-FS", status: "ACTIVE", planId: "P-F", nextBillingTime: "2026-10-12T09:00:00Z", lastPaymentTime: null, quantity: 60 }, revised),
        env: ENV,
      });
      expect(out).toMatchObject({ checked: 1, expired: 1 });
      const [bid] = await tx.select({ amount: featuredBids.amountCents, pending: featuredBids.pendingAmountCents, position: featuredBids.position }).from(featuredBids).where(eq(featuredBids.listingId, s.listingId));
      expect(bid).toEqual({ amount: 6000, pending: null, position: 1 });
      // Back to what PayPal bills; nothing outstanding.
      expect(await subRow(tx, s.sub.id)).toEqual({ status: "active", quantity: 60, requested: 60 });
      const [audit] = await tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.action, RAISE_EXPIRED_ACTION));
      expect(audit).toBeDefined();
    });
  });

  it("cancels a subscription that has been paused for a whole cycle, and its bids with it", async () => {
    await withTestDb(async (tx) => {
      const s = await confirmed(tx);
      await tx.update(featuredSubscriptions).set({ status: "paused", pausedAt: new Date("2026-09-12T09:00:00Z") }).where(eq(featuredSubscriptions.id, s.sub.id));
      await tx.update(featuredBids).set({ status: "outbid", position: null }).where(eq(featuredBids.listingId, s.listingId));
      setClock(new Date("2026-10-20T00:00:00Z"));
      const cancelled: string[] = [];
      const out = await syncFeaturedSubscriptions(tx, { client: client(null, [], cancelled), env: ENV });
      expect(out).toMatchObject({ checked: 1, cancelled: 1 });
      expect(cancelled).toEqual(["I-FS"]);
      expect((await subRow(tx, s.sub.id)).status).toBe("cancelled");
      const [bid] = await tx.select({ status: featuredBids.status }).from(featuredBids).where(eq(featuredBids.listingId, s.listingId));
      expect(bid!.status).toBe("cancelled");
    });
  });

  it("leaves a paused subscription alone inside the cycle", async () => {
    await withTestDb(async (tx) => {
      const s = await confirmed(tx);
      await tx.update(featuredSubscriptions).set({ status: "paused", pausedAt: new Date("2026-09-12T09:00:00Z") }).where(eq(featuredSubscriptions.id, s.sub.id));
      setClock(new Date("2026-10-01T00:00:00Z"));
      const out = await syncFeaturedSubscriptions(tx, { client: client(null), env: ENV });
      expect(out.checked).toBe(0);
    });
  });
});
