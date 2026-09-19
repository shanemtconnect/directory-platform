import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { invoiceHistory, ownerSubscriptions } from "@/lib/db/queries/billing";
import { billingConfigured, paypalManageAccountUrl } from "@/lib/billing/paypal";
import { SubscriptionCard } from "@/components/billing/SubscriptionCard";
import { InvoiceTable } from "@/components/billing/InvoiceTable";
import { PageHeader } from "@/components/ui/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * `/account/billing`.
 *
 * Everything here is scoped by the QUERY, not by this page: `ownerSubscriptions`
 * matches on the listing's owner_id, so a page that forgot to filter would
 * still return nothing. The /account layout redirects anonymous visitors; this
 * page re-derives the viewer anyway, because a layout is not a boundary.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Billing",
  robots: { index: false, follow: false },
};

export default async function BillingPage() {
  const viewer = await currentViewer();
  const e = siteConfig.entity;

  // The layout has already sent anonymous visitors to /login; this is the
  // belt-and-braces for a direct render.
  if (viewer.role === "public") {
    return (
      <main>
        <h1>Billing</h1>
        <p>
          <a href="/login?next=/account/billing">Sign in</a> to see your plan.
        </p>
      </main>
    );
  }

  const profile = await ensureProfile(db, viewer);
  const subscriptions = await ownerSubscriptions(db, viewer, profile.id);
  const providerIds = subscriptions
    .map((s) => s.providerSubscriptionId)
    .filter((id): id is string => id !== null);
  const invoices = await invoiceHistory(db, viewer, providerIds);
  const manageUrl = paypalManageAccountUrl();

  return (
    <main data-testid="billing-page">
      <PageHeader
        title="Billing"
        back={{ href: "/account", label: "Your account" }}
        lede="Your plan, the payments PayPal has taken, and how to change or cancel."
      />

      {!billingConfigured() && (
        <Notice variant="status" testId="billing-unavailable">
          Subscriptions are not set up on this site yet. Nothing here can be changed — email{" "}
          <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a> if you need
          anything.
        </Notice>
      )}

      <section aria-labelledby="billing-plan">
        <h2 id="billing-plan">Your plan</h2>
        {subscriptions.length === 0 ? (
          <EmptyState
            title="You have no paid plan."
            testId="no-subscriptions"
            action={{ href: "/pricing", label: "See what the plans do" }}
          >
            <p>
              Every {e.singular} keeps its name, address, phone number, map pin and enquiry form
              for free — a plan buys reach and richness on top.{" "}
              <a href="/pricing">See what the plans do</a>.
            </p>
          </EmptyState>
        ) : (
          <ul data-testid="subscriptions" className="grid list-none gap-4 p-0">
            {subscriptions.map((subscription) => (
              <SubscriptionCard
                key={subscription.id}
                subscription={subscription}
                manageUrl={manageUrl}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="billing-history">
        <h2 id="billing-history">Payment history</h2>
        <InvoiceTable invoices={invoices} />
      </section>

      <section aria-labelledby="billing-verification">
        <h2 id="billing-verification">Verification</h2>
        <p>
          Verification is included with every paid plan, but paying is not what earns the badge: the{" "}
          {e.ownerNoun} still has to pass the check that proves they control the business. If a plan
          lapses, the badge goes with it. <a href="/trust">What our badges mean</a>.
        </p>
        <p className="text-sm text-muted">
          Questions about a payment? Email{" "}
          <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
        </p>
      </section>
    </main>
  );
}
