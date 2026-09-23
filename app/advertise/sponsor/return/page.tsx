import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { now } from "@/lib/clock";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { loginPath } from "@/lib/auth/next";
import { getPayPalClient } from "@/lib/billing/paypal";
import { BILLING_SYSTEM_VIEWER } from "@/lib/billing/process";
import { parseEvent, type PayPalEvent } from "@/lib/billing/webhooks";
import { applySponsorBillingEvent } from "@/lib/ads/billing";
import { advertiserCampaignBySubscription } from "@/lib/db/queries/ads";
import { PageHeader } from "@/components/ui/PageHeader";
import { Notice } from "@/components/ui/Notice";
import type { TestDb } from "@/lib/db/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sponsor payment",
  robots: { index: false, follow: false },
};

const HERE = "/advertise/sponsor/return";
const STATUS_EVENTS: Record<string, string> = {
  ACTIVE: "BILLING.SUBSCRIPTION.ACTIVATED",
  SUSPENDED: "BILLING.SUBSCRIPTION.SUSPENDED",
  CANCELLED: "BILLING.SUBSCRIPTION.CANCELLED",
  EXPIRED: "BILLING.SUBSCRIPTION.EXPIRED",
};

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * PayPal sends the advertiser back here. Reconciles the advertiser's OWN
 * campaign for the subscription id in the URL — the same shape as
 * /checkout/return, and gated the same way: a stranger's id reconciles nothing.
 */
export default async function SponsorReturnPage({ searchParams }: Props) {
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect(loginPath(HERE));
  const sp = await searchParams;
  const raw = sp.subscription_id;
  const providerSubscriptionId = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const profile = await ensureProfile(db, viewer);
  const handle = db as unknown as TestDb;

  const campaign =
    providerSubscriptionId === ""
      ? null
      : await advertiserCampaignBySubscription(handle, viewer, { profileId: profile.id, providerSubscriptionId });

  let state: "paid" | "pending" | "unknown" = "unknown";
  if (campaign !== null) {
    state = campaign.billingStatus === "active" ? "paid" : "pending";
    const client = getPayPalClient();
    if (client !== null && state !== "paid") {
      try {
        const view = await client.getSubscription(providerSubscriptionId);
        const eventType = view === null ? undefined : STATUS_EVENTS[view.status];
        if (view !== null && eventType !== undefined) {
          const at = now();
          const synthetic: unknown = {
            id: `sponsor-reconcile:${providerSubscriptionId}:${at.toISOString()}`,
            event_type: eventType,
            create_time: at.toISOString(),
            resource: {
              id: view.id,
              plan_id: view.planId,
              status: view.status,
              custom_id: campaign.id,
              billing_info: { next_billing_time: view.nextBillingTime },
            },
          };
          const event = parseEvent(synthetic) as PayPalEvent;
          const out = await db.transaction(async (tx) =>
            applySponsorBillingEvent(tx as unknown as TestDb, BILLING_SYSTEM_VIEWER, event, {
              providerSubscriptionId,
              customId: campaign.id,
            }),
          );
          if (out.outcome === "applied" && out.detail === "activate") state = "paid";
        }
      } catch (e) {
        console.error("[ads] sponsor reconcile failed:", e);
      }
    }
  }

  return (
    <main>
      <PageHeader title="Sponsor payment" back={{ href: "/advertise/sponsor", label: "Your campaigns" }} />
      {state === "paid" && (
        <Notice variant="success" testId="sponsor-paid" title="Payment approved">
          Thanks. Your campaign goes on the rails as soon as an admin has checked it — you will get an email.
        </Notice>
      )}
      {state === "pending" && (
        <Notice variant="status" testId="sponsor-payment-pending" title="Waiting for PayPal">
          PayPal has not confirmed the subscription yet. It usually takes a minute; this page is safe to reload.
        </Notice>
      )}
      {state === "unknown" && (
        <Notice variant="status" testId="sponsor-payment-unknown">
          That subscription does not match one of your campaigns.
        </Notice>
      )}
    </main>
  );
}
