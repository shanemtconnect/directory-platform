import { describe, expect, it } from "vitest";
import {
  billingConfigured,
  createPayPalClient,
  paypalApiBase,
  paypalManageAccountUrl,
  webhookVerificationConfigured,
  type PayPalHttp,
} from "./paypal";

const ENV = {
  PAYPAL_CLIENT_ID: "id",
  PAYPAL_CLIENT_SECRET: "secret",
  PAYPAL_WEBHOOK_ID: "WH-1",
};

interface Call { url: string; init: RequestInit }

function stub(responses: Record<string, unknown>, status = 200): {
  http: PayPalHttp;
  calls: Call[];
} {
  const calls: Call[] = [];
  const http: PayPalHttp = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const body = key === undefined ? {} : responses[key];
    return new Response(JSON.stringify(body), {
      status: key === undefined ? 404 : status,
      headers: { "content-type": "application/json" },
    });
  };
  return { http, calls };
}

const TOKEN = { "/v1/oauth2/token": { access_token: "tok", expires_in: 32400 } };

describe("billingConfigured", () => {
  it("is false until both credentials are present", () => {
    expect(billingConfigured({})).toBe(false);
    expect(billingConfigured({ PAYPAL_CLIENT_ID: "id" })).toBe(false);
    expect(billingConfigured({ PAYPAL_CLIENT_ID: " ", PAYPAL_CLIENT_SECRET: "s" })).toBe(false);
    expect(billingConfigured(ENV)).toBe(true);
  });
});

describe("webhookVerificationConfigured", () => {
  it("needs the webhook id as well — an unset one silently stops renewals", () => {
    expect(webhookVerificationConfigured({ ...ENV, PAYPAL_WEBHOOK_ID: "" })).toBe(false);
    expect(webhookVerificationConfigured(ENV)).toBe(true);
  });
});

describe("paypalApiBase", () => {
  it("is the sandbox unless the environment says live", () => {
    expect(paypalApiBase({})).toContain("sandbox");
    expect(paypalApiBase({ PAYPAL_ENV: "sandbox" })).toContain("sandbox");
    expect(paypalApiBase({ PAYPAL_ENV: "live" })).toBe("https://api-m.paypal.com");
  });
});

describe("paypalManageAccountUrl", () => {
  it("points at the same PayPal the subscription lives on", () => {
    expect(paypalManageAccountUrl({})).toContain("sandbox");
    expect(paypalManageAccountUrl({ PAYPAL_ENV: "live" })).toBe(
      "https://www.paypal.com/myaccount/autopay/",
    );
  });
});

describe("createSubscription", () => {
  it("posts the plan and returns the approval link", async () => {
    const { http, calls } = stub({
      ...TOKEN,
      "/v1/billing/subscriptions": {
        id: "I-SUB",
        status: "APPROVAL_PENDING",
        links: [
          { rel: "self", href: "https://api/x" },
          { rel: "approve", href: "https://paypal/approve/I-SUB" },
        ],
      },
    });
    const client = createPayPalClient({ env: ENV, http });

    const out = await client.createSubscription({
      planId: "P-1",
      customId: "row-1",
      returnUrl: "https://site/checkout/return",
      cancelUrl: "https://site/checkout/cancelled",
    });

    expect(out).toEqual({
      id: "I-SUB",
      status: "APPROVAL_PENDING",
      approveUrl: "https://paypal/approve/I-SUB",
    });
    const post = calls.find((c) => c.url.includes("/v1/billing/subscriptions"))!;
    expect(post.init.method).toBe("POST");
    const body = JSON.parse(String(post.init.body)) as Record<string, unknown>;
    expect(body.plan_id).toBe("P-1");
    expect(body.custom_id).toBe("row-1");
  });

  it("sends the plan override when a discount applies", async () => {
    const { http, calls } = stub({
      ...TOKEN,
      "/v1/billing/subscriptions": { id: "I-SUB", status: "APPROVAL_PENDING", links: [] },
    });
    const client = createPayPalClient({ env: ENV, http });
    await client.createSubscription({
      planId: "P-1",
      customId: "row-1",
      returnUrl: "r",
      cancelUrl: "c",
      planOverride: {
        billing_cycles: [
          { sequence: 2, pricing_scheme: { fixed_price: { value: "74.25", currency_code: "GBP" } } },
        ],
      },
    });
    const body = JSON.parse(
      String(calls.find((c) => c.url.includes("/v1/billing/subscriptions"))!.init.body),
    ) as { plan?: { billing_cycles?: unknown[] } };
    expect(body.plan?.billing_cycles).toHaveLength(1);
  });

  it("throws with PayPal's own message rather than a bare 400", async () => {
    const { http } = stub({ ...TOKEN }, 200);
    const client = createPayPalClient({ env: ENV, http });
    await expect(
      client.createSubscription({ planId: "P-1", customId: "x", returnUrl: "r", cancelUrl: "c" }),
    ).rejects.toThrow(/paypal/i);
  });
});

describe("getSubscription", () => {
  it("flattens the fields the reconcile job needs", async () => {
    const { http } = stub({
      ...TOKEN,
      "/v1/billing/subscriptions/I-SUB": {
        id: "I-SUB",
        status: "ACTIVE",
        plan_id: "P-1",
        billing_info: {
          next_billing_time: "2027-01-01T00:00:00Z",
          last_payment: { time: "2026-01-01T00:00:00Z", amount: { value: "99.00", currency_code: "GBP" } },
        },
      },
    });
    const client = createPayPalClient({ env: ENV, http });
    await expect(client.getSubscription("I-SUB")).resolves.toEqual({
      id: "I-SUB",
      status: "ACTIVE",
      planId: "P-1",
      nextBillingTime: "2027-01-01T00:00:00Z",
      lastPaymentTime: "2026-01-01T00:00:00Z",
    });
  });

  it("returns null when PayPal has never heard of it", async () => {
    const { http } = stub({ ...TOKEN });
    const client = createPayPalClient({ env: ENV, http });
    await expect(client.getSubscription("I-NOPE")).resolves.toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/cert.pem",
    "paypal-transmission-id": "t-1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-09-12T00:00:00Z",
  };

  it("asks PayPal and believes only SUCCESS", async () => {
    const ok = stub({ ...TOKEN, "verify-webhook-signature": { verification_status: "SUCCESS" } });
    const okClient = createPayPalClient({ env: ENV, http: ok.http });
    await expect(okClient.verifyWebhookSignature(headers, { id: "EV" })).resolves.toBe(true);

    const bad = stub({ ...TOKEN, "verify-webhook-signature": { verification_status: "FAILURE" } });
    const badClient = createPayPalClient({ env: ENV, http: bad.http });
    await expect(badClient.verifyWebhookSignature(headers, { id: "EV" })).resolves.toBe(false);
  });

  it("refuses without a webhook id instead of accepting an unsigned event", async () => {
    const { http, calls } = stub({ ...TOKEN });
    const client = createPayPalClient({ env: { ...ENV, PAYPAL_WEBHOOK_ID: "" }, http });
    await expect(client.verifyWebhookSignature(headers, { id: "EV" })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses when a signature header is missing", async () => {
    const { http, calls } = stub({ ...TOKEN });
    const client = createPayPalClient({ env: ENV, http });
    const { "paypal-transmission-sig": _sig, ...partial } = headers;
    await expect(client.verifyWebhookSignature(partial, { id: "EV" })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fails closed when PayPal cannot be reached", async () => {
    const http: PayPalHttp = async () => {
      throw new Error("network down");
    };
    const client = createPayPalClient({ env: ENV, http });
    await expect(client.verifyWebhookSignature(headers, { id: "EV" })).resolves.toBe(false);
  });
});

describe("access token", () => {
  it("is fetched once and reused", async () => {
    const { http, calls } = stub({
      ...TOKEN,
      "/v1/billing/subscriptions/I-SUB": { id: "I-SUB", status: "ACTIVE" },
    });
    const client = createPayPalClient({ env: ENV, http });
    await client.getSubscription("I-SUB");
    await client.getSubscription("I-SUB");
    expect(calls.filter((c) => c.url.includes("oauth2/token"))).toHaveLength(1);
  });
});
