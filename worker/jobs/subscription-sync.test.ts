import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, listings, subscriptions, user } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { ensureProfile } from "@/lib/auth/profile";
import { resetClock, setClock } from "@/lib/clock";
import { createPendingSubscription } from "@/lib/db/queries/billing";
import type { PayPalClient, PayPalSubscriptionView } from "@/lib/billing/paypal";
import { syncSubscriptions } from "./subscription-sync";

const SUB = "I-SYNC-1";
const ENV = { PAYPAL_PLAN_PREMIUM_ANNUAL: "P-1" };

afterEach(() => resetClock());

function client(view: PayPalSubscriptionView | null | "throw"): PayPalClient {
  return {
    createSubscription: async () => ({ id: SUB, status: "ACTIVE", approveUrl: null }),
    getSubscription: async () => {
      if (view === "throw") throw new Error("PayPal is down");
      return view;
    },
    cancelSubscription: async () => {},
    manageUrl: async () => null,
    verifyWebhookSignature: async () => true,
  };
}

async function lapsedRow(tx: TestDb) {
  const ctx = await makeScaffold(tx);
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "O", email: `${userId}@example.test` });
  const viewer = { role: "user" as const, userId };
  const { id: profileId } = await ensureProfile(tx, viewer);
  const listingId = await makeListing(tx, ctx, {
    ownerId: profileId,
    claimStatus: "verified",
    tier: "premium",
  });
  const id = await createPendingSubscription(tx, viewer, {
    listingId,
    profileId,
    tier: "premium",
    interval: "annual",
    providerPlanId: "P-1",
    ip: null,
  });
  await tx
    .update(subscriptions)
    .set({
      status: "active",
      providerSubscriptionId: SUB,
      currentPeriodEnd: new Date("2026-10-12T09:00:00Z"),
    })
    .where(eq(subscriptions.id, id));
  return { id, listingId };
}

describe("syncSubscriptions", () => {
  it("does nothing at all when PayPal is not configured", async () => {
    await withTestDb(async (tx) => {
      const s = await lapsedRow(tx);
      setClock(new Date("2026-10-20T00:00:00Z"));
      const out = await syncSubscriptions(tx, { client: null, env: ENV });
      expect(out).toEqual({ checked: 0, reconciled: 0, skipped: true });

      const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, s.id));
      expect(row!.status).toBe("active");
    });
  });

  it("leaves a row alone while it is still inside the grace period", async () => {
    await withTestDb(async (tx) => {
      await lapsedRow(tx);
      setClock(new Date("2026-10-14T00:00:00Z"));
      const out = await syncSubscriptions(tx, { client: client(null), env: ENV });
      expect(out.checked).toBe(0);
    });
  });

  it("restores a subscription PayPal says is still live — a missed renewal webhook", async () => {
    await withTestDb(async (tx) => {
      const s = await lapsedRow(tx);
      setClock(new Date("2026-10-20T00:00:00Z"));

      const out = await syncSubscriptions(tx, {
        client: client({
          id: SUB,
          status: "ACTIVE",
          planId: "P-1",
          nextBillingTime: "2027-10-12T09:00:00Z",
          lastPaymentTime: "2026-10-12T09:00:00Z",
        }),
        env: ENV,
      });
      expect(out).toMatchObject({ checked: 1, reconciled: 1 });

      const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, s.id));
      expect(row!.currentPeriodEnd?.toISOString()).toBe("2027-10-12T09:00:00.000Z");
      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("premium");
      expect(listing!.claimStatus).toBe("verified");
    });
  });

  it("lapses one PayPal says has ended, dropping verified back to claimed", async () => {
    await withTestDb(async (tx) => {
      const s = await lapsedRow(tx);
      setClock(new Date("2026-10-20T00:00:00Z"));

      await syncSubscriptions(tx, {
        client: client({
          id: SUB, status: "EXPIRED", planId: "P-1", nextBillingTime: null, lastPaymentTime: null,
        }),
        env: ENV,
      });

      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("free");
      expect(listing!.claimStatus).toBe("claimed");
    });
  });

  it("does not re-check a cancelled row once its listing has lapsed to free", async () => {
    await withTestDb(async (tx) => {
      const s = await lapsedRow(tx);
      setClock(new Date("2026-10-20T00:00:00Z"));
      const gone = client({
        id: SUB, status: "CANCELLED", planId: "P-1", nextBillingTime: null, lastPaymentTime: null,
      });

      const first = await syncSubscriptions(tx, { client: gone, env: ENV });
      expect(first).toMatchObject({ checked: 1, reconciled: 1 });
      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("free");

      // An hour later, and every hour after that: nothing to lose or restore,
      // so no PayPal call and no audit row.
      setClock(new Date("2026-10-20T01:00:00Z"));
      const second = await syncSubscriptions(tx, { client: gone, env: ENV });
      expect(second).toMatchObject({ checked: 0, reconciled: 0 });

      const cancels = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "billing.cancel"));
      expect(cancels.filter((a) => a.entityId === s.id)).toHaveLength(1);
    });
  });

  it("still checks a cancelled row whose listing keeps a paid tier until the period ends", async () => {
    await withTestDb(async (tx) => {
      // Cancelled mid-period: the tier stays until current_period_end, and the
      // sync is what performs the lapse on the day. So the row must stay in
      // the batch until the listing is free.
      const s = await lapsedRow(tx);
      await tx
        .update(subscriptions)
        .set({ status: "cancelled", cancelAtPeriodEnd: true })
        .where(eq(subscriptions.id, s.id));
      setClock(new Date("2026-10-20T00:00:00Z"));

      const out = await syncSubscriptions(tx, {
        client: client({
          id: SUB, status: "CANCELLED", planId: "P-1", nextBillingTime: null, lastPaymentTime: null,
        }),
        env: ENV,
      });
      expect(out).toMatchObject({ checked: 1, reconciled: 1 });
      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("free");
      expect(listing!.claimStatus).toBe("claimed");
    });
  });

  it("changes nothing when PayPal cannot be reached", async () => {
    await withTestDb(async (tx) => {
      const s = await lapsedRow(tx);
      setClock(new Date("2026-10-20T00:00:00Z"));

      const out = await syncSubscriptions(tx, { client: client("throw"), env: ENV });
      expect(out).toMatchObject({ checked: 1, reconciled: 0 });

      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("premium");
      expect(listing!.claimStatus).toBe("verified");
    });
  });
});
