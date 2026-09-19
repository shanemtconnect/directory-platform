import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { PageHeader } from "@/components/ui/PageHeader";
import { Notice } from "@/components/ui/Notice";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Checkout cancelled",
  robots: { index: false, follow: false },
};

/** Where PayPal sends somebody who backed out. Nothing has been charged. */
export default function CheckoutCancelledPage() {
  const e = siteConfig.entity;
  return (
    <main data-testid="checkout-cancelled">
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Nothing was charged" back={{ href: "/account", label: "Your account" }} />
        <Notice variant="status">
          You left PayPal before the subscription was set up, so no payment has been taken and
          your {e.singular} is unchanged.
        </Notice>
        <p>
          <a href="/pricing" className="btn btn-primary">Look at the plans again</a>
          {" · "}
          <a href="/account">Your account</a>
        </p>
      </div>
    </main>
  );
}
