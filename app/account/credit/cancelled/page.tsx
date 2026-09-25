import type { Metadata } from "next";
import { guardFeature } from "@/lib/features/guard";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Payment cancelled",
  robots: { index: false, follow: false },
};

/** Where PayPal sends a buyer who backed out of a top-up. Nothing was charged or credited. */
export default function CreditCancelledPage() {
  guardFeature("leadMarketplace");
  return (
    <main data-testid="credit-cancelled">
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Payment cancelled" />
        <EmptyState title="Nothing was charged" action={{ href: "/account/credit", label: "Back to your credit" }}>
          No credit was added. If you meant to top up, choose a pack again and you will be taken back to PayPal.
        </EmptyState>
      </div>
    </main>
  );
}
