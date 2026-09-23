import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { getPayPalOrdersClient, settleJobOrder, type SettleOutcome } from "@/lib/billing/orders";
import { BILLING_SYSTEM_VIEWER } from "@/lib/billing/process";
import { guardFeature } from "@/lib/features/guard";
import type { TestDb } from "@/lib/db/types";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";

/**
 * Where PayPal sends the buyer after approving the order.
 *
 * The buyer is standing here NOW, so the order is captured here rather than
 * waiting for the webhook — through the same `markJobPaid` the webhook uses,
 * so whichever lands second finds the row done. The order id on the query
 * string is PayPal's `token`; anyone can put one there, and all it lets them
 * do is capture an order the buyer already approved, which is what we want.
 * A poster need not be signed in: a stranger who paid has no account.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payment",
  robots: { index: false, follow: false },
};

function first(v: string | string[] | undefined): string | null {
  const value = Array.isArray(v) ? v[0] : v;
  return value === undefined || value.trim() === "" ? null : value.trim();
}

const ORDER_ID = /^[A-Z0-9-]{8,64}$/i;

export default async function PostAJobReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  guardFeature("jobBoard");
  const orderId = first((await searchParams).token);

  let outcome: SettleOutcome = { outcome: "unknown-order" };
  if (orderId !== null && ORDER_ID.test(orderId)) {
    outcome = await db.transaction(async (tx) =>
      settleJobOrder(tx as unknown as TestDb, {
        client: getPayPalOrdersClient(),
        viewer: BILLING_SYSTEM_VIEWER,
        orderId,
      }),
    );
  }

  const paid = outcome.outcome === "paid" || outcome.outcome === "already-paid";

  return (
    <main data-testid="post-job-return" data-outcome={outcome.outcome}>
      <div className="mx-auto max-w-2xl">
        <PageHeader title={paid ? "Paid — your post is in the queue" : "Finishing your payment"} />
        {paid ? (
          <Notice variant="success" testId="post-job-paid" title="What happens next">
            <p>
              Thank you. Someone reads every post before it goes on {siteConfig.name}; we will email you
              when it is live and again {siteConfig.jobs.reminderDays} days before it closes. PayPal
              emails the receipt.
            </p>
            <p className="mb-0">
              <a href="/jobs">See the jobs that are open now</a>
            </p>
          </Notice>
        ) : outcome.outcome === "not-configured" ? (
          <Notice variant="error" testId="post-job-not-configured">
            Card payments are not set up on this site yet. Nothing has been charged.
          </Notice>
        ) : outcome.outcome === "unknown-order" ? (
          <Notice variant="error" testId="post-job-unknown-order">
            We could not match this payment to a post. If PayPal shows a charge, email{" "}
            <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a> with the
            PayPal reference and we will sort it out.
          </Notice>
        ) : (
          <Notice variant="status" testId="post-job-pending" title="Still with PayPal">
            <p>
              PayPal has not confirmed the payment yet. If it goes through, the post joins the queue
              on its own — there is nothing more for you to do, and we will email you when it is live.
            </p>
            <p className="mb-0">
              If PayPal shows the payment as declined, <a href="/post-a-job">start the post again</a>.
            </p>
          </Notice>
        )}
      </div>
    </main>
  );
}
