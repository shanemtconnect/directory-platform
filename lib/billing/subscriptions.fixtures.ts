/** Shared by subscriptions.test.ts and subscriptions.race.test.ts. */
import * as fx from "./__fixtures__/paypal";
import type { CreateSubscriptionInput, PayPalClient, PayPalSubscriptionView } from "./paypal";

export const ENV = { PAYPAL_PLAN_PREMIUM_ANNUAL: fx.PLAN_ID, PAYPAL_PLAN_PREMIUM_MONTHLY: "P-PRE-M" };

export interface Recorder {
  client: PayPalClient;
  created: CreateSubscriptionInput[];
  cancelled: string[];
}

export function recorder(
  opts: { fail?: boolean; view?: PayPalSubscriptionView | null; subId?: string } = {},
): Recorder {
  const created: CreateSubscriptionInput[] = [];
  const cancelled: string[] = [];
  return {
    created,
    cancelled,
    client: {
      createSubscription: async (input) => {
        created.push(input);
        if (opts.fail) throw new Error("PayPal create subscription failed: INVALID");
        return {
          id: opts.subId ?? fx.SUB_ID,
          status: "APPROVAL_PENDING",
          approveUrl: "https://paypal/approve",
        };
      },
      getSubscription: async () => opts.view ?? null,
      cancelSubscription: async (id) => {
        cancelled.push(id);
      },
      manageUrl: async () => "https://paypal/manage",
      verifyWebhookSignature: async () => true,
    },
  };
}

export const base = { tier: "premium" as const, interval: "annual" as const, ip: null, couponCode: null };

