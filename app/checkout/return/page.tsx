import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { getPayPalClient } from "@/lib/billing/paypal";
import { reconcileSubscription } from "@/lib/billing/subscriptions";
import { subscriptionForEvent } from "@/lib/db/queries/billing";
import type { TestDb } from "@/lib/db/types";

/**
 * Where PayPal sends the buyer after they approve.
 *
 * The ACTIVATED webhook is the source of truth and usually arrives within
 * seconds — but the buyer is standing here NOW, and a page that says "we are
 * waiting for PayPal" while their listing still shows the free tier is how a
 * new customer's first impression is that it did not work.
 *
 * So this asks PayPal directly and writes down the answer, through exactly the
 * same state machine the webhook uses. If the webhook has already landed, the
 * reconcile is a no-op writing the same values. If PayPal is unreachable,
 * nothing is granted and the page says the subscription is being set up — the
 * webhook will finish it.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Subscription",
  robots: { index: false, follow: false },
};

function first(v: string | string[] | undefined): string | null {
  const value = Array.isArray(v) ? v[0] : v;
  return value === undefined || value.trim() === "" ? null : value.trim();
}

export default async function CheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect("/login?next=/account/billing");

  const params = await searchParams;
  const providerSubscriptionId = first(params.subscription_id);
  const e = siteConfig.entity;

  let confirmed = false;
  let listingPath: string | null = null;

  if (providerSubscriptionId !== null) {
    const result = await db.transaction(async (tx) => {
      const handle = tx as unknown as TestDb;
      const out = await reconcileSubscription(handle, {
        client: getPayPalClient(),
        providerSubscriptionId,
      });
      const sub = await subscriptionForEvent(handle, { role: "admin", userId: "00000000-0000-0000-0000-000000000000" }, {
        providerSubscriptionId,
        customId: null,
      });
      return { out, sub };
    });

    confirmed = result.out.outcome === "applied" && result.out.action === "activate";
    listingPath = result.sub?.listingPath ?? null;

    if (confirmed && result.sub) {
      // The listing ranks differently the moment its tier changes.
      revalidatePath(result.sub.listingPath);
      revalidatePath(result.sub.cityPath);
    }
  }

  return (
    <main data-testid="checkout-return" data-confirmed={String(confirmed)}>
      <h1>{confirmed ? "Your subscription is live" : "Setting up your subscription"}</h1>
      {confirmed ? (
        <p data-testid="return-confirmed">
          Thank you — the plan is active and your {e.singular} has been upgraded.
        </p>
      ) : (
        <p data-testid="return-pending">
          PayPal has your approval and we are waiting for them to confirm the first payment. This
          usually takes a few seconds. Your {e.singular} updates on its own; there is nothing else
          for you to do.
        </p>
      )}
      <p>
        <a href="/account/billing">Your billing</a>
        {listingPath !== null && (
          <>
            {" · "}
            <a href={listingPath}>See your {e.singular}</a>
          </>
        )}
      </p>
      <p className="text-sm text-muted">
        Verification is a separate check. We will be in touch about it — paying does not put the
        badge on the page.
      </p>
    </main>
  );
}
