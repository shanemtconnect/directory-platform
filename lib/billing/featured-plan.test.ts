import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import {
  FEATURED_PLAN_ENV_VAR,
  featuredPlanIdFor,
  featuredPlanNameFor,
  featuredPlanRequestBody,
  featuredUnitAmount,
} from "./featured-plan";
import { createPayPalClient, type PayPalHttp } from "./paypal";

describe("featured plan", () => {
  it("has one env var, separate from the tier plans", () => {
    expect(FEATURED_PLAN_ENV_VAR).toBe("PAYPAL_PLAN_FEATURED");
    expect(featuredPlanIdFor({ PAYPAL_PLAN_FEATURED: " P-F1 " })).toBe("P-F1");
    expect(featuredPlanIdFor({})).toBeNull();
    expect(featuredPlanIdFor({ PAYPAL_PLAN_FEATURED: "  " })).toBeNull();
  });

  it("bills exactly one major unit of the site currency per unit", () => {
    expect(featuredUnitAmount()).toEqual({ value: "1.00", currency_code: siteConfig.currency });
  });

  it("is a quantity-supported plan with a single open-ended monthly REGULAR cycle", () => {
    const body = featuredPlanRequestBody("PROD-1");
    expect(body.product_id).toBe("PROD-1");
    expect(body.quantity_supported).toBe(true);
    expect(body.billing_cycles).toHaveLength(1);
    const [cycle] = body.billing_cycles;
    expect(cycle).toMatchObject({
      tenure_type: "REGULAR",
      sequence: 1,
      total_cycles: 0,
      frequency: { interval_unit: "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { value: "1.00", currency_code: siteConfig.currency } },
    });
    expect(body.payment_preferences.auto_bill_outstanding).toBe(true);
    expect("taxes" in body).toBe(false);
  });

  it("has a stable name so the setup script is idempotent", () => {
    expect(featuredPlanNameFor()).toBe(featuredPlanNameFor());
    expect(featuredPlanNameFor()).toContain(siteConfig.shortName);
    expect(featuredPlanRequestBody("PROD-1").name).toBe(featuredPlanNameFor());
  });
});

interface Call { url: string; init: RequestInit }

function stub(responses: Record<string, unknown>, status = 200): { http: PayPalHttp; calls: Call[] } {
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

const ENV = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
const TOKEN = { "/v1/oauth2/token": { access_token: "tok", expires_in: 32400 } };

describe("PayPalClient quantity support", () => {
  it("sends the quantity on create, as PayPal's string", async () => {
    const { http, calls } = stub({
      ...TOKEN,
      "/v1/billing/subscriptions": {
        id: "I-F1",
        status: "APPROVAL_PENDING",
        links: [{ rel: "approve", href: "https://paypal.test/approve" }],
      },
    });
    const client = createPayPalClient({ env: ENV, http });
    const created = await client.createSubscription({
      planId: "P-F1",
      customId: "row",
      returnUrl: "https://x/return",
      cancelUrl: "https://x/cancel",
      quantity: 75,
    });
    expect(created.approveUrl).toBe("https://paypal.test/approve");
    const body = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(body.quantity).toBe("75");
  });

  it("omits quantity for the tier plans, which do not support it", async () => {
    const { http, calls } = stub({ ...TOKEN, "/v1/billing/subscriptions": { id: "I-1" } });
    const client = createPayPalClient({ env: ENV, http });
    await client.createSubscription({
      planId: "P-1",
      customId: "row",
      returnUrl: "https://x/return",
      cancelUrl: "https://x/cancel",
    });
    const body = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect("quantity" in body).toBe(false);
  });

  it("reads the quantity back on a subscription view", async () => {
    const { http } = stub({
      ...TOKEN,
      "/v1/billing/subscriptions/I-F1": { id: "I-F1", status: "ACTIVE", plan_id: "P-F1", quantity: "75" },
    });
    const client = createPayPalClient({ env: ENV, http });
    const view = await client.getSubscription("I-F1");
    expect(view?.quantity).toBe(75);
  });

  it("revises the quantity through /revise and hands back the approval link", async () => {
    const { http, calls } = stub({
      ...TOKEN,
      "/v1/billing/subscriptions/I-F1/revise": {
        plan_id: "P-F1",
        quantity: "40",
        links: [{ rel: "approve", href: "https://paypal.test/revise-approve" }],
      },
    });
    const client = createPayPalClient({ env: ENV, http });
    const out = await client.reviseSubscription!("I-F1", {
      quantity: 40,
      returnUrl: "https://x/return",
      cancelUrl: "https://x/cancel",
    });
    expect(out.approveUrl).toBe("https://paypal.test/revise-approve");
    const call = calls.find((c) => c.url.endsWith("/revise"))!;
    expect(call.init.method).toBe("POST");
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body.quantity).toBe("40");
    expect(body.application_context).toMatchObject({
      return_url: "https://x/return",
      cancel_url: "https://x/cancel",
    });
  });

  it("suspends and activates without consent, tolerating PayPal's already-in-that-state 422", async () => {
    const seen: string[] = [];
    const http: PayPalHttp = async (url, init) => {
      if (url.includes("/v1/oauth2/token")) return new Response(JSON.stringify(TOKEN["/v1/oauth2/token"]), { status: 200 });
      seen.push(`${init.method} ${url.split("/v1/billing/subscriptions/")[1]}`);
      return url.endsWith("/activate")
        ? new Response(JSON.stringify({ name: "SUBSCRIPTION_STATUS_INVALID" }), { status: 422 })
        : new Response(null, { status: 204 });
    };
    const client = createPayPalClient({ env: ENV, http });
    await client.suspendSubscription!("I-F1", "outbid");
    await client.activateSubscription!("I-F1", "re-entered");
    expect(seen).toEqual(["POST I-F1/suspend", "POST I-F1/activate"]);
  });

  it("throws on a failed revise so the caller's transaction rolls back", async () => {
    const http: PayPalHttp = async (url) =>
      url.includes("/v1/oauth2/token")
        ? new Response(JSON.stringify(TOKEN["/v1/oauth2/token"]), { status: 200 })
        : new Response(JSON.stringify({ name: "INVALID", message: "nope" }), { status: 422 });
    const client = createPayPalClient({ env: ENV, http });
    await expect(
      client.reviseSubscription!("I-F1", {
        quantity: 40,
        returnUrl: "https://x/return",
        cancelUrl: "https://x/cancel",
      }),
    ).rejects.toThrow(/revise/);
  });
});
