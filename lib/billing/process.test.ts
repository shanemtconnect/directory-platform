import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { listings, processedEvents, subscriptions, user } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { ensureProfile } from "@/lib/auth/profile";
import { resetClock, setClock } from "@/lib/clock";
import { createPendingSubscription } from "@/lib/db/queries/billing";
import { listingPaths } from "@/lib/db/queries/paths";
import { ADMIN_VIEWER } from "@/worker/viewer";
import * as fx from "./__fixtures__/paypal";
import { processPayPalWebhook } from "./process";
import type { PayPalClient } from "./paypal";

const ENV = {
  PAYPAL_CLIENT_ID: "id",
  PAYPAL_CLIENT_SECRET: "secret",
  PAYPAL_WEBHOOK_ID: "WH",
  PAYPAL_PLAN_PREMIUM_ANNUAL: fx.PLAN_ID,
};

const HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/c.pem",
  "paypal-transmission-id": "t",
  "paypal-transmission-sig": "s",
  "paypal-transmission-time": "2026-09-12T09:00:00Z",
};

function fakeClient(verify = true): PayPalClient {
  return {
    createSubscription: async () => ({ id: "I", status: "APPROVAL_PENDING", approveUrl: null }),
    getSubscription: async () => null,
    cancelSubscription: async () => {},
    manageUrl: async () => null,
    verifyWebhookSignature: async () => verify,
  };
}

afterEach(() => resetClock());

async function seed(tx: TestDb) {
  const ctx = await makeScaffold(tx);
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "O", email: `${userId}@example.test` });
  const viewer = { role: "user" as const, userId };
  const { id: profileId } = await ensureProfile(tx, viewer);
  const listingId = await makeListing(tx, ctx, { ownerId: profileId, claimStatus: "claimed" });
  const subscriptionId = await createPendingSubscription(tx, viewer, {
    listingId,
    profileId,
    tier: "premium",
    interval: "annual",
    providerPlanId: fx.PLAN_ID,
    ip: null,
  });
  await tx
    .update(subscriptions)
    .set({ providerSubscriptionId: fx.SUB_ID })
    .where(eq(subscriptions.id, subscriptionId));
  return { listingId, subscriptionId, profileId };
}

function post(payload: unknown) {
  return { raw: JSON.stringify(payload), headers: HEADERS };
}

describe("processPayPalWebhook", () => {
  it("503s when billing is not configured, so PayPal retries rather than losing the event", async () => {
    await withTestDb(async (tx) => {
      const out = await processPayPalWebhook(tx, {
        client: null,
        env: {},
        ...post(fx.activated()),
      });
      expect(out.status).toBe(503);
    });
  });

  it("400s on a body that is not an event", async () => {
    await withTestDb(async (tx) => {
      const out = await processPayPalWebhook(tx, {
        client: fakeClient(),
        env: ENV,
        raw: "{not json",
        headers: HEADERS,
      });
      expect(out.status).toBe(400);
    });
  });

  it("401s when the signature does not verify, and writes nothing", async () => {
    await withTestDb(async (tx) => {
      await seed(tx);
      const out = await processPayPalWebhook(tx, {
        client: fakeClient(false),
        env: ENV,
        ...post(fx.activated()),
      });
      expect(out.status).toBe(401);
      const events = await tx.select().from(processedEvents);
      expect(events).toHaveLength(0);
    });
  });

  it("applies an activation and reports the paths to revalidate", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-12T09:00:10Z"));
      const s = await seed(tx);
      const out = await processPayPalWebhook(tx, {
        client: fakeClient(),
        env: ENV,
        ...post(fx.activated()),
      });

      expect(out.status).toBe(200);
      expect(out.outcome).toBe("applied");
      // The route busts exactly what `listingPaths` says — one list for the
      // webhook, the sync job and every admin decision.
      expect(out.revalidate?.paths).toEqual(await listingPaths(tx, ADMIN_VIEWER, s.listingId));

      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("premium");
    });
  });

  it("is idempotent: a redelivered event changes nothing the second time", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-12T09:00:10Z"));
      const s = await seed(tx);
      const args = { client: fakeClient(), env: ENV, ...post(fx.activated()) };

      const first = await processPayPalWebhook(tx, args);
      expect(first.outcome).toBe("applied");

      // Cancel in between, then redeliver the activation. A second application
      // would silently restore a tier that has been taken away.
      await tx
        .update(subscriptions)
        .set({ status: "cancelled" })
        .where(eq(subscriptions.id, s.subscriptionId));
      await tx.update(listings).set({ tier: "free" }).where(eq(listings.id, s.listingId));

      const second = await processPayPalWebhook(tx, args);
      expect(second.status).toBe(200);
      expect(second.outcome).toBe("duplicate");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("free");
    });
  });

  it("200s an event type it has no handler for, and records it", async () => {
    await withTestDb(async (tx) => {
      await seed(tx);
      const out = await processPayPalWebhook(tx, {
        client: fakeClient(),
        env: ENV,
        ...post(fx.unknownEvent()),
      });
      expect(out).toMatchObject({ status: 200, outcome: "ignored" });
      expect(await tx.select().from(processedEvents)).toHaveLength(1);
    });
  });

  it("200s an event for a subscription this site has never heard of", async () => {
    await withTestDb(async (tx) => {
      const out = await processPayPalWebhook(tx, {
        client: fakeClient(),
        env: ENV,
        ...post(fx.activated()),
      });
      expect(out).toMatchObject({ status: 200, outcome: "unknown-subscription" });
    });
  });

  it("runs the whole cancel-after-verified transition end to end", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-12T09:00:10Z"));
      const s = await seed(tx);
      const client = fakeClient();
      await processPayPalWebhook(tx, { client, env: ENV, ...post(fx.activated()) });
      await tx
        .update(listings)
        .set({ claimStatus: "verified" })
        .where(eq(listings.id, s.listingId));

      setClock(new Date("2026-11-01T00:00:00Z"));
      await processPayPalWebhook(tx, { client, env: ENV, ...post(fx.cancelled()) });

      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      // The paid period ended on 12 October, so cancelling in November lapses.
      expect(listing!.tier).toBe("free");
      expect(listing!.claimStatus).toBe("claimed");
    });
  });
});
