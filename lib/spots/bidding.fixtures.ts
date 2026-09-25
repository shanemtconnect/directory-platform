/** Shared by bidding.test.ts and bidding.race.test.ts: a fake PayPal and a bid helper. */
import type { TestDb } from "@/test/db";
import type { PayPalClient, PayPalSubscriptionView } from "@/lib/billing/paypal";
import type { SpotKey } from "@/lib/db/queries/spots";
import { placeBid } from "./bidding";

export const ENV = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", PAYPAL_WEBHOOK_ID: "WH", PAYPAL_PLAN_FEATURED: "P-F" };

export interface Calls {
  created: { customId: string; quantity: number | null | undefined; planId: string }[];
  revised: { id: string; quantity: number }[];
  cancelled: string[];
  suspended: string[];
  activated: string[];
}

export function fakeClient(opts: { view?: PayPalSubscriptionView | null; delayCreateMs?: number } = {}): { client: PayPalClient; calls: Calls } {
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

export interface Bidder {
  viewer: { role: "user"; userId: string };
  profileId: string;
  listingId: string;
  name: string;
}

export async function bid(tx: TestDb, client: PayPalClient, who: Bidder, spot: SpotKey, amountCents: number) {
  return placeBid(tx, {
    client, env: ENV, viewer: who.viewer, profileId: who.profileId, listingId: who.listingId, spot, amountCents, ip: "1.1.1.1",
  });
}
