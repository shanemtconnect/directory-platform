import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { guardFeature } from "@/lib/features/guard";
import { getPayPalOrdersClient } from "@/lib/billing/orders";
import { settleTopupOrder, type TopupSettleOutcome } from "@/lib/billing/credit-topup";
import { BILLING_SYSTEM_VIEWER } from "@/lib/billing/process";
import { creditBalance } from "@/lib/db/queries/credits";
import { formatCredit } from "@/lib/credits/format";
import type { TestDb } from "@/lib/db/types";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";

/**
 * Where PayPal sends the buyer after approving a top-up. The order is
 * captured here, while the buyer is standing here, through the same locked
 * settle the webhook uses — whichever lands second finds it done. The order
 * id is PayPal's `token`; anyone can put one on the query string, and all it
 * lets them do is capture an order its buyer already approved, credited to
 * the account that started it. Only that account is told the amount.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lead credit payment",
  robots: { index: false, follow: false },
};

function first(v: string | string[] | undefined): string | null {
  const value = Array.isArray(v) ? v[0] : v;
  return value === undefined || value.trim() === "" ? null : value.trim();
}

const ORDER_ID = /^[A-Z0-9-]{8,64}$/i;

export default async function CreditReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  guardFeature("leadMarketplace");
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect("/login?next=/account/credit");
  const orderId = first((await searchParams).token);

  let outcome: TopupSettleOutcome = { outcome: "unknown-order" };
  if (orderId !== null && ORDER_ID.test(orderId)) {
    outcome = await db.transaction(async (tx) =>
      settleTopupOrder(tx as unknown as TestDb, {
        client: getPayPalOrdersClient(),
        viewer: BILLING_SYSTEM_VIEWER,
        orderId,
      }),
    );
  }

  const profile = await ensureProfile(db, viewer);
  const mine = "userId" in outcome && outcome.userId === profile.id;
  const credited = mine && (outcome.outcome === "credited" || outcome.outcome === "already-credited");
  const balance = await creditBalance(db, profile.id);

  return (
    <main data-testid="credit-return" data-outcome={mine ? outcome.outcome : "unknown-order"}>
      <div className="mx-auto max-w-2xl">
        <PageHeader title={credited ? "Credit added" : "Finishing your payment"} />
        {credited && "cents" in outcome ? (
          <Notice variant="success" testId="credit-return-credited">
            {formatCredit(outcome.cents)} has been added. Your balance is now {formatCredit(balance)}. PayPal
            emails the payment receipt.
          </Notice>
        ) : outcome.outcome === "not-configured" ? (
          <Notice variant="error" testId="credit-return-not-configured">
            Card payments are not set up on this site yet. Nothing has been charged.
          </Notice>
        ) : mine ? (
          <Notice variant="status" testId="credit-return-pending" title="Still with PayPal">
            PayPal has not confirmed the payment yet. If it goes through, the credit is added on its own —
            there is nothing more for you to do.
          </Notice>
        ) : (
          <Notice variant="error" testId="credit-return-unknown">
            We could not match this payment to a top-up on your account. If PayPal shows a charge, email{" "}
            <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a> with the PayPal
            reference and we will sort it out.
          </Notice>
        )}
        <p>
          <a href="/account/credit" className="btn btn-primary">Back to your credit</a>
        </p>
      </div>
    </main>
  );
}
