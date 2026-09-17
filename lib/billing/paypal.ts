/**
 * The only place this codebase talks to PayPal.
 *
 * It is an INTERFACE first and an implementation second. No PayPal credentials
 * exist in development, so every caller takes a `PayPalClient` and the tests
 * hand them a fake driven by recorded payloads. The real client is a thin
 * wrapper over `fetch` with a cached OAuth token; there is nothing in it worth
 * mocking a network for.
 *
 * Stripe does not appear anywhere in this repo and must not: the seller is in
 * Jersey, where Stripe is region-blocked. The provider-neutral column names in
 * `lib/db/schema/money.ts` are what make a future swap a change to this folder
 * rather than a migration.
 */

export type PayPalHttp = (url: string, init: RequestInit) => Promise<Response>;

export interface PayPalAmount {
  readonly value: string;
  readonly currency_code: string;
}

export interface PricingScheme {
  readonly fixed_price: PayPalAmount;
}

export interface BillingCycleOverride {
  readonly sequence: number;
  readonly pricing_scheme: PricingScheme;
}

/** The subset of PayPal's inline plan override this codebase ever sends. */
export interface PlanOverride {
  readonly billing_cycles: readonly BillingCycleOverride[];
}

export interface CreateSubscriptionInput {
  readonly planId: string;
  /** Our own subscriptions row id. It comes back on every webhook. */
  readonly customId: string;
  readonly returnUrl: string;
  readonly cancelUrl: string;
  readonly subscriberEmail?: string | null;
  readonly planOverride?: PlanOverride | null;
}

export interface CreatedSubscription {
  readonly id: string;
  readonly status: string;
  /** Where the buyer is sent to approve. Null if PayPal did not offer one. */
  readonly approveUrl: string | null;
}

export interface PayPalSubscriptionView {
  readonly id: string;
  readonly status: string;
  readonly planId: string | null;
  readonly nextBillingTime: string | null;
  readonly lastPaymentTime: string | null;
}

export interface PayPalClient {
  createSubscription(input: CreateSubscriptionInput): Promise<CreatedSubscription>;
  getSubscription(id: string): Promise<PayPalSubscriptionView | null>;
  cancelSubscription(id: string, reason: string): Promise<void>;
  /** The buyer-facing page for changing a card. Null when PayPal offers none. */
  manageUrl(id: string): Promise<string | null>;
  /**
   * `rawBody` is the request body exactly as PayPal sent it. It is spliced
   * into the verify request untouched, because the signature is over those
   * bytes and a re-serialised object is not them. The caller must have
   * parsed it already: an invalid document here is a malformed verify call.
   */
  verifyWebhookSignature(
    headers: Record<string, string | null | undefined>,
    rawBody: string,
  ): Promise<boolean>;
}

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined): string => (v ?? "").trim();

/**
 * Sandbox unless told otherwise. A deploy that forgets PAYPAL_ENV takes test
 * money, which is recoverable; the other default is not.
 */
export function paypalApiBase(env: Env = process.env): string {
  return clean(env.PAYPAL_ENV) === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

/**
 * Where a customer manages the card behind a subscription.
 *
 * PayPal keeps the payment method on the PayPal account, not on the
 * subscription, so there is nothing for this site to collect or store — the
 * honest "change payment method" link is PayPal's own automatic-payments page.
 * A per-subscription `edit` link is used in preference when PayPal offers one.
 */
export function paypalManageAccountUrl(env: Env = process.env): string {
  const host = clean(env.PAYPAL_ENV) === "live" ? "www.paypal.com" : "www.sandbox.paypal.com";
  return `https://${host}/myaccount/autopay/`;
}

export function billingConfigured(env: Env = process.env): boolean {
  return clean(env.PAYPAL_CLIENT_ID) !== "" && clean(env.PAYPAL_CLIENT_SECRET) !== "";
}

/**
 * Separate from `billingConfigured` because it fails differently: without the
 * webhook id every delivery is rejected as unverifiable, so renewals stop and
 * nothing in the application looks broken until a customer's card is charged
 * and their listing has already lapsed.
 */
export function webhookVerificationConfigured(env: Env = process.env): boolean {
  return billingConfigured(env) && clean(env.PAYPAL_WEBHOOK_ID) !== "";
}

interface Link {
  rel?: string;
  href?: string;
}

function linkHref(links: unknown, rel: string): string | null {
  if (!Array.isArray(links)) return null;
  const hit = (links as Link[]).find((l) => l?.rel === rel);
  return typeof hit?.href === "string" ? hit.href : null;
}

/** PayPal signs a webhook with five headers. All five or nothing. */
const SIGNATURE_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

export interface PayPalResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly json: Record<string, unknown>;
}

/** An authenticated call to any PayPal path. */
export type PayPalRequest = (path: string, init?: RequestInit) => Promise<PayPalResponse>;

/**
 * The token-caching request function the client is built on, exported for
 * `scripts/paypal-setup.ts`.
 *
 * The setup script creates a product and four plans, which are catalogue
 * operations the application never performs — so they are not on
 * `PayPalClient`. A one-off script reaching for the raw requester is honest;
 * widening the interface the whole app depends on so a script can use it twice
 * a year is not.
 */
export function createPayPalRequest(opts: { env?: Env; http?: PayPalHttp } = {}): PayPalRequest {
  const env = opts.env ?? process.env;
  const http = opts.http ?? ((url, init) => fetch(url, init));
  const base = paypalApiBase(env);

  let token: string | null = null;
  let tokenExpiresAt = 0;

  async function accessToken(): Promise<string> {
    // A minute of slack: a token that expires while the request is in flight
    // is a 401 the caller sees as a failed payment.
    if (token !== null && Date.now() < tokenExpiresAt - 60_000) return token;

    const basic = Buffer.from(
      `${clean(env.PAYPAL_CLIENT_ID)}:${clean(env.PAYPAL_CLIENT_SECRET)}`,
    ).toString("base64");
    const res = await http(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!res.ok || typeof json.access_token !== "string") {
      throw new Error(`PayPal authentication failed (${res.status})`);
    }
    token = json.access_token;
    tokenExpiresAt = Date.now() + (json.expires_in ?? 300) * 1000;
    return token;
  }

  return async function call(path, init = {}) {
    const bearer = await accessToken();
    const res = await http(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text().catch(() => "");
    let json: Record<string, unknown> = {};
    if (text !== "") {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text };
      }
    }
    return { status: res.status, ok: res.ok, json };
  };
}

export function createPayPalClient(opts: { env?: Env; http?: PayPalHttp } = {}): PayPalClient {
  const env = opts.env ?? process.env;
  const call = createPayPalRequest(opts);

  /** PayPal's own `message`/`details` beat "request failed with 400". */
  function fail(path: string, status: number, json: Record<string, unknown>): Error {
    const message = typeof json.message === "string" ? json.message : "no message";
    const name = typeof json.name === "string" ? json.name : String(status);
    return new Error(`PayPal ${path} failed: ${name} — ${message}`);
  }

  return {
    async createSubscription(input) {
      const body = {
        plan_id: input.planId,
        custom_id: input.customId,
        ...(input.subscriberEmail
          ? { subscriber: { email_address: input.subscriberEmail } }
          : {}),
        ...(input.planOverride ? { plan: input.planOverride } : {}),
        application_context: {
          user_action: "SUBSCRIBE_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      };
      const { ok, status, json } = await call("/v1/billing/subscriptions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!ok || typeof json.id !== "string") {
        throw fail("create subscription", status, json);
      }
      return {
        id: json.id,
        status: typeof json.status === "string" ? json.status : "APPROVAL_PENDING",
        approveUrl: linkHref(json.links, "approve"),
      };
    },

    async getSubscription(id) {
      const { ok, json } = await call(`/v1/billing/subscriptions/${encodeURIComponent(id)}`);
      if (!ok || typeof json.id !== "string") return null;
      const billing = (json.billing_info ?? {}) as {
        next_billing_time?: string;
        last_payment?: { time?: string };
      };
      return {
        id: json.id,
        status: typeof json.status === "string" ? json.status : "UNKNOWN",
        planId: typeof json.plan_id === "string" ? json.plan_id : null,
        nextBillingTime: billing.next_billing_time ?? null,
        lastPaymentTime: billing.last_payment?.time ?? null,
      };
    },

    async cancelSubscription(id, reason) {
      const { ok, status, json } = await call(
        `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`,
        { method: "POST", body: JSON.stringify({ reason }) },
      );
      // 204 on success. 422 means PayPal already considers it cancelled, which
      // is the state the caller wanted — treating it as an error would leave a
      // customer unable to cancel a subscription that is already gone.
      if (!ok && status !== 422) throw fail("cancel subscription", status, json);
    },

    async manageUrl(id) {
      const { ok, json } = await call(`/v1/billing/subscriptions/${encodeURIComponent(id)}`);
      if (!ok) return null;
      return linkHref(json.links, "edit") ?? linkHref(json.links, "approve");
    },

    async verifyWebhookSignature(headers, rawBody) {
      const webhookId = clean(env.PAYPAL_WEBHOOK_ID);
      // Fail closed, always. An unverifiable event that is trusted is a free
      // subscription for anyone who can guess this URL.
      if (webhookId === "") {
        console.error("[billing] PAYPAL_WEBHOOK_ID is unset — every webhook is rejected");
        return false;
      }
      const values = SIGNATURE_HEADERS.map((h) => clean(headers[h] ?? undefined));
      if (values.some((v) => v === "")) return false;
      const [authAlgo, certUrl, transmissionId, sig, time] = values as [
        string, string, string, string, string,
      ];

      // The envelope is serialised WITHOUT the event, then the raw bytes are
      // spliced in as the last member. PayPal signs the body it sent —
      // whitespace, escapes, number forms and all — and `JSON.stringify` of
      // a parsed copy normalises every one of those, which turns a genuine
      // event into a verification FAILURE.
      const envelope = JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: sig,
        transmission_time: time,
        webhook_id: webhookId,
      });
      const body = `${envelope.slice(0, -1)},"webhook_event":${rawBody}}`;

      try {
        const { ok, json } = await call("/v1/notifications/verify-webhook-signature", {
          method: "POST",
          body,
        });
        return ok && json.verification_status === "SUCCESS";
      } catch (e) {
        // PayPal unreachable. Rejecting means PayPal retries; accepting means
        // trusting a payload nobody checked.
        console.error("[billing] webhook verification could not be performed:", e);
        return false;
      }
    },
  };
}

/** Null rather than a throw: the pages and jobs all have a "not configured" path. */
export function getPayPalClient(env: Env = process.env): PayPalClient | null {
  return billingConfigured(env) ? createPayPalClient({ env }) : null;
}
