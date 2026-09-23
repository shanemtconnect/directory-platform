import { siteConfig } from "@/config/site.config";
import type { PayPalAmount, PlanRequestBody } from "./plans";

/**
 * The one PayPal plan behind every featured spot on the site.
 *
 * "One unit, one major unit of the site currency, monthly, for ever", with
 * `quantity_supported` on — so a listing's whole featured spend is one
 * subscription whose quantity is the sum of its featured bids
 * (`lib/spots/rank.ts`, `quantityFor`). A bid that moves changes the quantity;
 * it never creates a second subscription. Created by
 * `scripts/paypal-setup.ts` beside the tier plans and read from the
 * environment like them.
 *
 * What PayPal's own documentation says about the two calls this leans on, and
 * what it means here:
 *
 *  - `POST /v1/billing/subscriptions` accepts `quantity` when the plan is
 *    `quantity_supported`. The first bid creates the subscription with it and
 *    the buyer approves it once.
 *  - `POST /v1/billing/subscriptions/{id}/revise` accepts a new `quantity`
 *    and "requires the buyer's consent": PayPal answers with an approve link
 *    and sends BILLING.SUBSCRIPTION.UPDATED once the buyer has clicked it.
 *    An owner raising their own bid is standing in front of us and is sent to
 *    that link. A DECREASE forced by somebody else's bid cannot wait for a
 *    click, so the model does not: the outbid position is dropped and the
 *    lower quantity is what `featured_subscriptions.requested_quantity` says
 *    from that moment. The revise is requested, the hourly `spots-sync`
 *    re-requests it until PayPal's confirmed quantity agrees, and Task 45's
 *    outbid email is the click that lands it. The consent-free alternative —
 *    PATCH `plan.billing_cycles[@sequence==1].pricing_scheme.fixed_price` on
 *    the subscription — is documented as not touching a cycle due within ten
 *    days and is the thing to try in sandbox if approvals prove to be the
 *    bottleneck.
 */

export const FEATURED_PLAN_ENV_VAR = "PAYPAL_PLAN_FEATURED";

const clean = (v: string | undefined): string => (v ?? "").trim();

export function featuredPlanIdFor(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const id = clean(env[FEATURED_PLAN_ENV_VAR]);
  return id === "" ? null : id;
}

/** One major unit. The bid amount IS the quantity. */
export function featuredUnitAmount(): PayPalAmount {
  return { value: "1.00", currency_code: siteConfig.currency };
}

/** Stable per site, so the setup script reuses the plan it made last time. */
export function featuredPlanNameFor(): string {
  return `${siteConfig.shortName} Featured spots (per unit, monthly)`;
}

export interface FeaturedPlanRequestBody extends PlanRequestBody {
  readonly quantity_supported: true;
}

export function featuredPlanRequestBody(productId: string): FeaturedPlanRequestBody {
  return {
    product_id: productId,
    name: featuredPlanNameFor(),
    description: "Featured placement, billed monthly per unit of the winning bids",
    status: "ACTIVE",
    quantity_supported: true,
    billing_cycles: [
      {
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        tenure_type: "REGULAR",
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: featuredUnitAmount() },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: "CONTINUE",
      // Three tries, then PayPal suspends and the sync drops every bid.
      payment_failure_threshold: 3,
    },
  };
}
