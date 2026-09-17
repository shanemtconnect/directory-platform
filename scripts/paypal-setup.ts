import { siteConfig } from "@/config/site.config";
import {
  billingConfigured,
  createPayPalRequest,
  paypalApiBase,
  type PayPalRequest,
} from "@/lib/billing/paypal";
import {
  PAID_PLANS,
  planEnvVar,
  planNameFor,
  planRequestBody,
  productNameFor,
} from "@/lib/billing/plans";

/**
 * Creates the PayPal product and the one plan per billable tier and interval
 * that `config/site.config.ts` describes, then prints the env lines to paste.
 *
 *   corepack pnpm tsx scripts/paypal-setup.ts
 *
 * Sandbox by default (`PAYPAL_ENV=live` for the real thing). Run it again as
 * often as you like: it matches on the product and plan NAME and reuses what
 * is already there, so a second run prints the same ids rather than creating a
 * second set of plans nobody is subscribed to.
 *
 * What it deliberately does NOT do is change an existing plan's price. PayPal
 * prices are versioned per subscription and editing one in place does not move
 * anybody who has already subscribed; changing what a plan costs is a new plan
 * and a migration of the people on the old one, not a script run. Matching is
 * by NAME ONLY: an existing plan is reused as it stands, and its live price is
 * not compared with the config. If the config price has changed, give the
 * plan a new name (see `planNameFor`) and run this again.
 */

interface NamedThing {
  id?: string;
  name?: string;
}

async function findProduct(call: PayPalRequest, name: string): Promise<string | null> {
  // 20 per page is PayPal's maximum; a site has one product.
  for (let page = 1; page <= 10; page++) {
    const { ok, json } = await call(`/v1/catalogs/products?page_size=20&page=${page}`);
    if (!ok) return null;
    const products = (json.products ?? []) as NamedThing[];
    const hit = products.find((p) => p.name === name);
    if (hit?.id) return hit.id;
    if (products.length < 20) return null;
  }
  return null;
}

async function ensureProduct(call: PayPalRequest): Promise<string> {
  const name = productNameFor();
  const existing = await findProduct(call, name);
  if (existing !== null) {
    console.log(`product   reused  ${existing}  ${name}`);
    return existing;
  }

  const { ok, status, json } = await call("/v1/catalogs/products", {
    method: "POST",
    body: JSON.stringify({
      name,
      description: `Paid plans for ${siteConfig.name}`,
      type: "SERVICE",
      category: "ADVERTISING",
      home_url: `https://${siteConfig.domain}`,
    }),
  });
  if (!ok || typeof json.id !== "string") {
    throw new Error(`could not create the product (${status}): ${JSON.stringify(json)}`);
  }
  console.log(`product   created ${json.id}  ${name}`);
  return json.id;
}

interface ExistingPlan extends NamedThing {
  status?: string;
}

async function findPlan(
  call: PayPalRequest,
  productId: string,
  name: string,
): Promise<ExistingPlan | null> {
  for (let page = 1; page <= 10; page++) {
    const { ok, json } = await call(
      `/v1/billing/plans?product_id=${encodeURIComponent(productId)}&page_size=20&page=${page}`,
    );
    if (!ok) return null;
    const plans = (json.plans ?? []) as ExistingPlan[];
    const hit = plans.find((p) => p.name === name);
    if (hit) return hit;
    if (plans.length < 20) return null;
  }
  return null;
}

async function main(): Promise<void> {
  if (!billingConfigured()) {
    console.error(
      "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set. There is nothing to create.",
    );
    process.exit(1);
  }

  const live = (process.env.PAYPAL_ENV ?? "").trim() === "live";
  console.log(`Using ${paypalApiBase()} (${live ? "LIVE — real money" : "sandbox"})\n`);

  const call = createPayPalRequest();
  const productId = await ensureProduct(call);
  const lines: string[] = [];

  for (const { tier, interval } of PAID_PLANS) {
    const name = planNameFor(tier, interval);
    const existing = await findPlan(call, productId, name);

    if (existing?.id) {
      console.log(`plan      reused  ${existing.id}  ${name}`);
      lines.push(`${planEnvVar(tier, interval)}=${existing.id}`);
      continue;
    }

    const { ok, status, json } = await call("/v1/billing/plans", {
      method: "POST",
      body: JSON.stringify(planRequestBody(tier, interval, productId)),
    });
    if (!ok || typeof json.id !== "string") {
      throw new Error(`could not create plan "${name}" (${status}): ${JSON.stringify(json)}`);
    }
    console.log(`plan      created ${json.id}  ${name}`);
    lines.push(`${planEnvVar(tier, interval)}=${json.id}`);
  }

  console.log(`\nAdd these to the site's environment:\n`);
  console.log(lines.join("\n"));
  console.log(
    `\nPAYPAL_WEBHOOK_ID is NOT created here — add the webhook in the PayPal dashboard, ` +
      `pointed at https://${siteConfig.domain}/api/webhooks/paypal, subscribe it to the ` +
      `BILLING.SUBSCRIPTION.* and PAYMENT.SALE.COMPLETED events, and paste its id in. ` +
      `Without it every delivery is rejected and renewals stop silently.`,
  );
}

await main();
