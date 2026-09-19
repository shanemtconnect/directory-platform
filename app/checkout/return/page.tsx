import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { getPayPalClient } from "@/lib/billing/paypal";
import { reconcileSubscription } from "@/lib/billing/subscriptions";
import { subscriptionForOwnerByProviderId } from "@/lib/db/queries/billing";
import { revalidateListingPaths } from "@/lib/revalidate/listing";
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
 *
 * The id on the query string is PayPal's, and anyone signed in can put one
 * there. So the row is resolved through the OWNER first (global constraint
 * 24): a subscription this profile does not own is the same as one that does
 * not exist — no PayPal call, no audit row, no revalidation, no listing link.
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
    const profile = await ensureProfile(db, viewer);
    const owned = await subscriptionForOwnerByProviderId(db, viewer, {
      providerSubscriptionId,
      profileId: profile.id,
    });

    if (owned !== null) {
      // One PayPal round-trip inside an open transaction, so the answer and
      // the rows it changes commit together. Fine at this volume; do not add
      // a second call in here.
      const out = await db.transaction(async (tx) =>
        reconcileSubscription(tx as unknown as TestDb, {
          client: getPayPalClient(),
          providerSubscriptionId,
        }),
      );

      confirmed = out.outcome === "applied" && out.action === "activate";
      listingPath = owned.listingPath;

      if (out.outcome === "applied") {
        // The listing ranks and renders differently the moment its tier
        // changes — and that is true of every change the state machine
        // applied, not only the activation this page congratulates the buyer
        // on. A cancellation or expiry the webhook missed and this call caught
        // up on has moved the tier just the same. The list is `listingPaths`,
        // read inside the transaction by `applyEffect`: the same pages the
        // webhook and the sync job bust, paginated city pages and the
        // category pillar included.
        revalidateListingPaths(out.paths);
      }
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
