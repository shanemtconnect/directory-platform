import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { listingForCheckout } from "@/lib/db/queries/billing";
import { billingConfigured } from "@/lib/billing/paypal";
import { parseBillingInterval, parseTier } from "@/lib/billing/plans";
import { CheckoutForm } from "@/components/billing/CheckoutForm";
import { PlanSummary } from "@/components/billing/PlanSummary";

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

  const raw = (await searchParams).listing;
  const listingId = Array.isArray(raw) ? raw[0] : raw;

  const profile = await ensureProfile(db, viewer);
  const listing =
    listingId === undefined
      ? null
      : await listingForCheckout(db, viewer, { listingId, profileId: profile.id });

  if (listing === null) {
    return (
      <main>
        <h1>Checkout</h1>
        <p data-testid="checkout-refused">
          You can only subscribe for a {e.singular} you have claimed. Find yours and claim it
          first, and the plan will be waiting.
        </p>
        <p>
          <a href="/search">Find your {e.singular}</a> · <a href="/account">Your account</a>
        </p>
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
        <h1>Checkout</h1>
        <p data-testid="billing-unavailable">
          Subscriptions are not set up on this site yet, so there is nothing to pay for here.
          Email <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a> and
          we will sort it out with you directly.
        </p>
      </main>
    );
  }

  return (
    <main data-testid="checkout-page">
      <h1>Checkout</h1>
      <PlanSummary
        name={tier}
        tier={spec}
        interval={interval}
        locale={siteConfig.locale}
        currency={siteConfig.currency}
        subjectName={listing.name}
      />
      <CheckoutForm
        listingId={listing.id}
        tier={tier}
        interval={interval}
        providerLabel="Continue to PayPal"
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
    </main>
  );
}
