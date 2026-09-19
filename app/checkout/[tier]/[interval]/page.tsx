import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { listingForCheckout, ownerCheckoutListings } from "@/lib/db/queries/billing";
import { previewCoupon } from "@/lib/db/queries/coupons";
import { applyDiscount, discountSummary } from "@/lib/billing/coupons";
import { planAmount } from "@/lib/billing/plans";
import { billingConfigured } from "@/lib/billing/paypal";
import { parseBillingInterval, parseTier } from "@/lib/billing/plans";
import { CheckoutForm } from "@/components/billing/CheckoutForm";
import { PlanSummary } from "@/components/billing/PlanSummary";
import { CHECKOUT_STEPS } from "@/components/billing/steps";
import { PageHeader } from "@/components/ui/PageHeader";
import { Steps } from "@/components/ui/Steps";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * `/checkout/[tier]/[interval]?listing=<id>`.
 *
 * Per-request by definition — it reads a session and a listing id — so there
 * is no cache to lose by reading searchParams here.
 *
 * Three refusals, and none of them is a 500:
 *   - not signed in      -> the login page, with a way back
 *   - not the owner      -> a panel saying so
 *   - billing not set up -> a panel saying so, but only once ownership has
 *                           been established
 * A tier or interval that is not a thing we sell is the only 404: those are
 * path segments, and a URL that names a plan which does not exist is not a
 * page.
 *
 * With no `?listing=` at all — which is how the public pricing page links
 * here, since it cannot know whose business is reading it — the page lists
 * the viewer's own claimed listings and lets them pick. Each option is a plain
 * link back to this URL with the id on it. Somebody with nothing claimed gets
 * the refusal.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Checkout",
  robots: { index: false, follow: false },
};

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ tier: string; interval: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tier: tierRaw, interval: intervalRaw } = await params;
  const tier = parseTier(tierRaw);
  const interval = parseBillingInterval(intervalRaw);
  if (tier === null || interval === null) notFound();

  const viewer = await currentViewer();
  const here = `/checkout/${tier}/${interval}`;
  if (viewer.role === "public") redirect(`/login?next=${encodeURIComponent(here)}`);

  const e = siteConfig.entity;
  const spec = siteConfig.tiers[tier];

  const query = await searchParams;
  const raw = query.listing;
  const listingId = Array.isArray(raw) ? raw[0] : raw;
  const rawCoupon = Array.isArray(query.coupon) ? query.coupon[0] : query.coupon;

  const profile = await ensureProfile(db, viewer);

  if (listingId === undefined) {
    const mine = await ownerCheckoutListings(db, viewer, profile.id);
    if (mine.length > 0) {
      const withListing = (id: string) =>
        `${here}?listing=${encodeURIComponent(id)}` +
        (rawCoupon !== undefined && rawCoupon.trim() !== ""
          ? `&coupon=${encodeURIComponent(rawCoupon.trim())}`
          : "");
      return (
        <main data-testid="checkout-listing-picker">
          <div className="mx-auto max-w-2xl">
          <PageHeader
            title="Checkout"
            back={{ href: "/pricing", label: "Compare the plans" }}
            lede={`Which ${e.singular} is the ${spec.label} plan for?`}
          />
          <Steps steps={CHECKOUT_STEPS} current={0} />
          <ul className="card-grid">
            {mine.map((l) => (
              <li key={l.id} className="card card-hover">
                <a href={withListing(l.id)} data-testid="checkout-listing-option" rel="nofollow">
                  {l.name}
                </a>
                {l.tier !== "free" && (
                  <span className="text-sm text-muted"> — already on {siteConfig.tiers[l.tier].label}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">
            <a href="/pricing">Compare the plans</a> · <a href="/account">Your account</a>
          </p>
          </div>
        </main>
      );
    }
  }

  const listing =
    listingId === undefined
      ? null
      : await listingForCheckout(db, viewer, { listingId, profileId: profile.id });

  if (listing === null) {
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <PageHeader title="Checkout" back={{ href: "/pricing", label: "Compare the plans" }} />
          <EmptyState
            title={`You can only subscribe for a ${e.singular} you have claimed.`}
            testId="checkout-refused"
            action={{ href: "/search", label: `Find your ${e.singular}` }}
          >
            <p>
              Find yours and claim it first, and the plan will be waiting.{" "}
              <a href="/search">Find your {e.singular}</a> · <a href="/account">Your account</a>
            </p>
          </EmptyState>
        </div>
      </main>
    );
  }

  // AFTER the ownership check, deliberately. Whether this site takes card
  // payments is not something a stranger should be able to learn by pointing a
  // URL at somebody else's listing — and an owner who cannot be charged still
  // needs a different sentence from one who does not own the thing.
  if (!billingConfigured()) {
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <PageHeader title="Checkout" back={{ href: "/pricing", label: "Compare the plans" }} />
          <Notice variant="status" testId="billing-unavailable">
            Subscriptions are not set up on this site yet, so there is nothing to pay for here.
            Email <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a> and
            we will sort it out with you directly.
          </Notice>
        </div>
      </main>
    );
  }

  /**
   * A code on the URL is how an outreach email carries its own offer. It is
   * previewed, never spent: the redemption that counts against
   * `max_redemptions` happens inside the checkout transaction, under a row
   * lock. An invalid code here is simply not shown, and the field still holds
   * it so the person can correct it and see why.
   */
  let discount: { code: string; firstPayment: number; summary: string } | undefined;
  if (rawCoupon !== undefined && rawCoupon.trim() !== "") {
    const preview = await previewCoupon(db, viewer, { code: rawCoupon, tier, interval });
    if (preview.outcome === "ok") {
      const net = applyDiscount(planAmount(tier, interval), preview.coupon);
      discount = {
        code: preview.coupon.code,
        firstPayment: Number(net.value),
        summary: discountSummary(preview.coupon),
      };
    }
  }

  return (
    <main data-testid="checkout-page">
      <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Checkout"
        back={{ href: "/pricing", label: "Compare the plans" }}
        lede={`Check the plan and the ${e.singular} it is for, then PayPal takes the payment.`}
      />
      <Steps steps={CHECKOUT_STEPS} current={1} />
      <PlanSummary
        name={tier}
        tier={spec}
        interval={interval}
        locale={siteConfig.locale}
        currency={siteConfig.currency}
        subjectName={listing.name}
        discount={discount}
      />
      <CheckoutForm
        listingId={listing.id}
        tier={tier}
        interval={interval}
        providerLabel="Continue to PayPal"
        defaultCoupon={rawCoupon}
      />
      <p className="text-sm text-muted">
        Paying does not by itself put the Verified badge on your {e.singular}. The{" "}
        {e.ownerNoun} still has to pass the check that proves they control the business — the
        subscription opens that check, it does not pass it.{" "}
        <a href="/trust">What our badges mean</a>.
      </p>
      <p className="text-sm text-muted">
        <a href="/pricing">Compare the plans</a> · <a href="/terms">Terms</a>
      </p>
      </div>
    </main>
  );
}
