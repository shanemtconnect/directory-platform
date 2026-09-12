import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";

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
      <h1>Nothing was charged</h1>
      <p>
        You left PayPal before the subscription was set up, so no payment has been taken and your{" "}
        {e.singular} is unchanged.
      </p>
      <p>
        <a href="/pricing">Look at the plans again</a> · <a href="/account">Your account</a>
      </p>
    </main>
  );
}
