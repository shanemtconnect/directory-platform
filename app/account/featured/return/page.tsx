import { after } from "next/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { getPayPalClient } from "@/lib/billing/paypal";
import { featuredSubscriptionForOwnerByProviderId } from "@/lib/db/queries/spots";
import { reconcileFeaturedSubscription } from "@/lib/spots/webhook";
import { revalidateListingPaths } from "@/lib/revalidate/listing";
import type { TestDb } from "@/lib/db/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Notice } from "@/components/ui/Notice";

/**
 * Where PayPal sends the owner after approving a featured subscription or a
 * revision of it. Same shape as /checkout/return: the row is resolved through
 * the OWNER first, PayPal is asked directly so the page does not have to say
 * "wait for the webhook", and the spot's pages are busted after the response.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Featured spots",
  robots: { index: false, follow: false },
};

function first(v: string | string[] | undefined): string | null {
  const value = Array.isArray(v) ? v[0] : v;
  return value === undefined || value.trim() === "" ? null : value.trim();
}

export default async function FeaturedReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect("/login?next=/account");

  const params = await searchParams;
  const providerSubscriptionId = first(params.subscription_id);

  let confirmed = false;
  let listingId: string | null = null;

  if (providerSubscriptionId !== null) {
    const profile = await ensureProfile(db, viewer);
    const owned = await featuredSubscriptionForOwnerByProviderId(db, viewer, {
      providerSubscriptionId,
      profileId: profile.id,
    });
    if (owned !== null) {
      listingId = owned.listingId;
      const out = await db.transaction(async (tx) =>
        reconcileFeaturedSubscription(tx as unknown as TestDb, {
          client: getPayPalClient(),
          providerSubscriptionId,
        }),
      );
      confirmed = out.outcome === "applied" && out.action === "confirm";
      if (out.outcome === "applied") after(() => revalidateListingPaths(out.paths));
    }
  }

  const back = listingId === null ? "/account" : `/account/listings/${listingId}/featured`;

  return (
    <main data-testid="featured-return" data-confirmed={String(confirmed)}>
      <div className="mx-auto max-w-2xl">
        <PageHeader title={confirmed ? "Your bid is live" : "Setting up your featured spot"} />
        {confirmed ? (
          <Notice variant="success" testId="featured-return-confirmed">
            PayPal has confirmed it. Your bid now counts, and the page shows the new order.
          </Notice>
        ) : (
          <Notice variant="status" testId="featured-return-pending">
            PayPal has your approval and we are waiting for the confirmation. This usually takes a
            few seconds; your bid starts counting on its own.
          </Notice>
        )}
        <p>
          <a href={back} className="btn btn-primary">Back to your featured spots</a>
        </p>
      </div>
    </main>
  );
}
