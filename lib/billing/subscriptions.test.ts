import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  coupons,
  couponRedemptions,
  listings,
  subscriptions,
  user,
} from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { ensureProfile } from "@/lib/auth/profile";
import { resetClock, setClock } from "@/lib/clock";
import * as fx from "./__fixtures__/paypal";
import { ENV, base, recorder } from "./subscriptions.fixtures";
import { reconcileSubscription, startCheckout } from "./subscriptions";
import { listingPaths } from "@/lib/db/queries/paths";
import { ADMIN_VIEWER } from "@/worker/viewer";

afterEach(() => resetClock());

async function seed(tx: TestDb, patch: Partial<typeof listings.$inferInsert> = {}) {
  const ctx = await makeScaffold(tx);
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "O", email: `${userId}@example.test` });
  const viewer = { role: "user" as const, userId };
  const { id: profileId } = await ensureProfile(tx, viewer);
  const listingId = await makeListing(tx, ctx, {
    ownerId: profileId,
    claimStatus: "claimed",
    ...patch,
  });
  return { viewer, profileId, listingId };
}

describe("startCheckout", () => {
  it("says so when billing is not configured instead of throwing", async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const out = await startCheckout(tx, {
        client: null,
        env: ENV,
        viewer: s.viewer,
        profileId: s.profileId,
        listingId: s.listingId,
        ...base,
      });
      expect(out.outcome).toBe("not-configured");
    });
  });

  it("refuses a listing the viewer does not own, and writes nothing", async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const stranger = await seed(tx);
      const r = recorder();
      const out = await startCheckout(tx, {
        client: r.client,
        env: ENV,
        viewer: stranger.viewer,
        profileId: stranger.profileId,
        listingId: s.listingId,
        ...base,
      });
      expect(out.outcome).toBe("not-owner");
      expect(r.created).toHaveLength(0);
      expect(await tx.select().from(subscriptions)).toHaveLength(0);
    });
  });

  it("refuses when this deploy has no plan id for the tier", async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const r = recorder();
      const out = await startCheckout(tx, {
        client: r.client,
        env: {},
        viewer: s.viewer,
        profileId: s.profileId,
        listingId: s.listingId,
        ...base,
      });
      expect(out.outcome).toBe("no-plan");
    });
  });

  it("creates the row, calls PayPal with our id, and returns the approval link", async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const r = recorder();
      const out = await startCheckout(tx, {
        client: r.client,
        env: ENV,
        viewer: s.viewer,
        profileId: s.profileId,
        listingId: s.listingId,
        ...base,
      });

      expect(out).toMatchObject({ outcome: "approval", approveUrl: "https://paypal/approve" });
      expect(r.created[0]).toMatchObject({ planId: fx.PLAN_ID });

      const [row] = await tx.select().from(subscriptions);
      expect(row).toMatchObject({
        status: "approval_pending",
        providerSubscriptionId: fx.SUB_ID,
        tier: "premium",
      });
      // The row id is what comes back on every webhook.
      expect(r.created[0]!.customId).toBe(row!.id);
      // Nothing is paid for yet.
      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("free");
    });
  });

  it("sends a first-cycle override and counts the redemption when a coupon applies", async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const r = recorder();
      const code = `C${randomUUID().slice(0, 6)}`.toUpperCase();
      await tx.insert(coupons).values({
        code,
        discountType: "percent",
        value: "25.00",
        maxRedemptions: 1,
      });

      const out = await startCheckout(tx, {
        client: r.client,
        env: ENV,
        viewer: s.viewer,
        profileId: s.profileId,
        listingId: s.listingId,
        ...base,
        couponCode: code,
      });
      expect(out.outcome).toBe("approval");

      const override = r.created[0]!.planOverride!;
      // 249.00 less 25% — and only the ONE cycle the plan makes discountable.
      expect(override.billing_cycles[0]).toMatchObject({
        sequence: 2,
        pricing_scheme: { fixed_price: { value: "186.75" } },
      });

      const [row] = await tx.select().from(coupons).where(eq(coupons.code, code));
      expect(row!.redemptionCount).toBe(1);
    });
  });

  it("records which subscription the coupon was spent on", async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const r = recorder();
      const code = `C${randomUUID().slice(0, 6)}`.toUpperCase();
      await tx.insert(coupons).values({ code, discountType: "percent", value: "10.00" });

      const out = await startCheckout(tx, {
        client: r.client,
        env: ENV,
        viewer: s.viewer,
        profileId: s.profileId,
        listingId: s.listingId,
        ...base,
        couponCode: code,
      });
      if (out.outcome !== "approval") throw new Error(out.outcome);

      const [redemption] = await tx.select().from(couponRedemptions);
      expect(redemption!.subscriptionId).toBe(out.subscriptionId);
    });
  });

  it("refuses a listing that already has a live subscription, before PayPal is called", async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const r = recorder();
      const first = await startCheckout(tx, {
        client: r.client,
        env: ENV,
        viewer: s.viewer,
        profileId: s.profileId,
        listingId: s.listingId,
        ...base,
      });
      if (first.outcome !== "approval") throw new Error(first.outcome);

      for (const status of ["active", "past_due"]) {
        await tx.update(subscriptions).set({ status }).where(eq(subscriptions.id, first.subscriptionId));
        // An owner on Essential clicking "Choose Premium" is this call.
        const again = await startCheckout(tx, {
          client: r.client,
          env: { ...ENV, PAYPAL_PLAN_PREMIUM_MONTHLY: "P-PRE-M" },
          viewer: s.viewer,
          profileId: s.profileId,
          listingId: s.listingId,
          ...base,
          interval: "monthly",
        });
        expect(again.outcome, status).toBe("already-subscribed");
      }
      expect(r.created).toHaveLength(1);
      expect(await tx.select().from(subscriptions)).toHaveLength(1);
    });
  });

  it("rejects a bad coupon before anything is written or charged", async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const r = recorder();
      const out = await startCheckout(tx, {
        client: r.client,
        env: ENV,
        viewer: s.viewer,
        profileId: s.profileId,
        listingId: s.listingId,
        ...base,
        couponCode: "NOPE",
      });
      expect(out).toMatchObject({ outcome: "coupon-rejected", reason: "unknown" });
      expect(r.created).toHaveLength(0);
      expect(await tx.select().from(subscriptions)).toHaveLength(0);
    });
  });

  it("leaves no half-finished subscription when PayPal refuses", async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const r = recorder({ fail: true });

      // A PayPal failure THROWS rather than returning an outcome, because
      // that is what rolls the caller's transaction back. The action wraps it
      // exactly like this; here a savepoint stands in for the outer one.
      await expect(
        tx.transaction(async (sp) =>
          startCheckout(sp as unknown as TestDb, {
            client: r.client,
            env: ENV,
            viewer: s.viewer,
            profileId: s.profileId,
            listingId: s.listingId,
            ...base,
          }),
        ),
      ).rejects.toThrow(/PayPal/);

      expect(await tx.select().from(subscriptions)).toHaveLength(0);
    });
  });
});

describe("reconcileSubscription", () => {
  async function pending(tx: TestDb) {
    const s = await seed(tx);
    const r = recorder();
    await startCheckout(tx, {
      client: r.client,
      env: ENV,
      viewer: s.viewer,
      profileId: s.profileId,
      listingId: s.listingId,
      ...base,
    });
    return s;
  }

  it("activates a row PayPal says is live, without waiting for the webhook", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-12T09:00:10Z"));
      const s = await pending(tx);
      const r = recorder({
        view: {
          id: fx.SUB_ID,
          status: "ACTIVE",
          planId: fx.PLAN_ID,
          nextBillingTime: "2027-09-12T09:00:00Z",
          lastPaymentTime: null,
        },
      });

      const out = await reconcileSubscription(tx, {
        client: r.client,
        env: ENV,
        providerSubscriptionId: fx.SUB_ID,
      });
      expect(out.outcome).toBe("applied");
      if (out.outcome !== "applied") return;
      // The checkout return page busts these, the same list the webhook and
      // the sync job use, rather than naming the listing and city itself.
      expect(out.paths).toEqual(await listingPaths(tx, ADMIN_VIEWER, s.listingId));

      const [row] = await tx.select().from(subscriptions);
      expect(row!.status).toBe("active");
      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("premium");
    });
  });

  it("leaves everything alone while PayPal still says approval pending", async () => {
    await withTestDb(async (tx) => {
      await pending(tx);
      const r = recorder({
        view: {
          id: fx.SUB_ID,
          status: "APPROVAL_PENDING",
          planId: fx.PLAN_ID,
          nextBillingTime: null,
          lastPaymentTime: null,
        },
      });
      const out = await reconcileSubscription(tx, {
        client: r.client,
        env: ENV,
        providerSubscriptionId: fx.SUB_ID,
      });
      expect(out.outcome).toBe("pending");
      const [row] = await tx.select().from(subscriptions);
      expect(row!.status).toBe("approval_pending");
    });
  });

  it("never grants anything when PayPal cannot be reached", async () => {
    await withTestDb(async (tx) => {
      await pending(tx);
      const out = await reconcileSubscription(tx, {
        client: {
          ...recorder().client,
          getSubscription: async () => {
            throw new Error("network down");
          },
        },
        env: ENV,
        providerSubscriptionId: fx.SUB_ID,
      });
      expect(out.outcome).toBe("provider-error");
      const [row] = await tx.select().from(subscriptions);
      expect(row!.status).toBe("approval_pending");
    });
  });

  it("lapses a row PayPal says has been cancelled and expired", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-12T09:00:10Z"));
      const s = await pending(tx);
      const live = recorder({
        view: {
          id: fx.SUB_ID, status: "ACTIVE", planId: fx.PLAN_ID,
          nextBillingTime: "2026-10-12T09:00:00Z", lastPaymentTime: null,
        },
      });
      await reconcileSubscription(tx, { client: live.client, env: ENV, providerSubscriptionId: fx.SUB_ID });

      setClock(new Date("2026-11-01T00:00:00Z"));
      const gone = recorder({
        view: {
          id: fx.SUB_ID, status: "EXPIRED", planId: fx.PLAN_ID,
          nextBillingTime: null, lastPaymentTime: null,
        },
      });
      const out = await reconcileSubscription(tx, {
        client: gone.client,
        env: ENV,
        providerSubscriptionId: fx.SUB_ID,
      });
      expect(out.outcome).toBe("applied");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("free");
    });
  });

  it("says so when PayPal has never heard of the subscription", async () => {
    await withTestDb(async (tx) => {
      await pending(tx);
      const out = await reconcileSubscription(tx, {
        client: recorder({ view: null }).client,
        env: ENV,
        providerSubscriptionId: fx.SUB_ID,
      });
      expect(out.outcome).toBe("not-found");
    });
  });
});
