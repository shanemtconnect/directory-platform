"use client";

import { useActionState } from "react";
import {
  endSponsorCampaignAction,
  startSponsorCheckoutAction,
  updateSponsorCampaignAction,
  type SponsorActionState,
  type SponsorFormState,
} from "@/lib/actions/sponsor";
import type { AdvertiserCampaign } from "@/lib/db/queries/ads";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: SponsorFormState = { status: "idle" };
const idle: SponsorActionState = { status: "idle" };

const OPEN = new Set<AdvertiserCampaign["status"]>(["pending", "active", "paused"]);
const UNPAID = new Set<AdvertiserCampaign["billingStatus"]>(["none", "approval_pending"]);

function statusLabel(c: AdvertiserCampaign): string {
  if (c.status === "active" && c.billingStatus === "approval_pending") return "Approved — awaiting payment";
  return STATUS_LABEL[c.status];
}

function PayNow({ campaign }: { campaign: AdvertiserCampaign }) {
  const [state, action, pending] = useActionState(startSponsorCheckoutAction, idle);
  return (
    <form action={action} className="mt-2" data-testid={`sponsor-pay-${campaign.id}`}>
      <input type="hidden" name="campaignId" value={campaign.id} />
      {state.status === "error" && <Notice variant="error">{state.message}</Notice>}
      <SubmitButton pending={pending} pendingLabel="Opening PayPal…" testId="sponsor-pay-now">Pay now</SubmitButton>
    </form>
  );
}

function EndCampaign({ campaign }: { campaign: AdvertiserCampaign }) {
  const [state, action, pending] = useActionState(endSponsorCampaignAction, idle);
  if (state.status === "done") {
    return <Notice variant="success" testId="sponsor-ended">{state.message}</Notice>;
  }
  return (
    <form action={action} className="mt-2" data-testid={`sponsor-end-${campaign.id}`}>
      <input type="hidden" name="campaignId" value={campaign.id} />
      {state.status === "error" && <Notice variant="error">{state.message}</Notice>}
      <SubmitButton pending={pending} pendingLabel="Ending…" variant="secondary" testId="sponsor-end-campaign">
        End campaign
      </SubmitButton>
      <span className="ml-2 text-sm text-muted">Takes it off the rails and cancels the subscription.</span>
    </form>
  );
}

const STATUS_LABEL: Record<AdvertiserCampaign["status"], string> = {
  pending: "Waiting for review",
  active: "Live",
  paused: "Paused by the site",
  ended: "Ended",
  rejected: "Not accepted",
};

const BILLING_LABEL: Record<AdvertiserCampaign["billingStatus"], string> = {
  none: "No card on file",
  approval_pending: "Payment not completed",
  active: "Paid",
  past_due: "Payment overdue",
  cancelled: "Cancelled — runs to the end of the paid month",
  suspended: "Payment suspended",
  expired: "Subscription expired",
};

function EditForm({ campaign, titleMax, blurbMax }: { campaign: AdvertiserCampaign; titleMax: number; blurbMax: number }) {
  const [state, action, pending] = useActionState(updateSponsorCampaignAction, initial);
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm">Edit the copy</summary>
      <p className="text-sm text-muted">
        Any change takes the campaign off the rails until an admin has looked at it again.
      </p>
      <form action={action} data-testid={`sponsor-edit-${campaign.id}`}>
        <input type="hidden" name="campaignId" value={campaign.id} />
        <p>
          <label htmlFor={`title-${campaign.id}`}>Headline</label>
          <input id={`title-${campaign.id}`} name="title" defaultValue={campaign.title} maxLength={titleMax} required />
        </p>
        <p>
          <label htmlFor={`blurb-${campaign.id}`}>Blurb</label>
          <textarea id={`blurb-${campaign.id}`} name="blurb" defaultValue={campaign.blurb} maxLength={blurbMax} rows={3} required />
        </p>
        <p>
          <label htmlFor={`url-${campaign.id}`}>Link</label>
          <input id={`url-${campaign.id}`} name="targetUrl" type="url" defaultValue={campaign.targetUrl} required />
        </p>
        {state.status === "error" && <Notice variant="error">{state.message}</Notice>}
        {state.status === "submitted" && <Notice variant="success">{state.message}</Notice>}
        <SubmitButton pending={pending} pendingLabel="Saving…" variant="secondary">Save changes</SubmitButton>
      </form>
    </details>
  );
}

export function SponsorCampaignList({
  campaigns,
  titleMax,
  blurbMax,
  paymentsAvailable,
}: {
  campaigns: AdvertiserCampaign[];
  titleMax: number;
  blurbMax: number;
  /** PayPal and the sponsor plan are configured, so "Pay now" can go somewhere. */
  paymentsAvailable: boolean;
}) {
  if (campaigns.length === 0) return null;
  return (
    <ul className="m-0 list-none p-0" data-testid="sponsor-campaigns">
      {campaigns.map((c) => (
        <li key={c.id} className="card mb-3" data-testid={`sponsor-campaign-${c.id}`} data-status={c.status}>
          <h3 className="mt-0">{c.title}</h3>
          <p className="text-sm">
            <strong data-testid="sponsor-status-label">{statusLabel(c)}</strong>
            <span className="text-muted"> · {BILLING_LABEL[c.billingStatus]}</span>
          </p>
          <p className="text-sm text-muted">{c.blurb}</p>
          {c.status === "rejected" && c.rejectionReason !== null && (
            <Notice variant="status" testId="sponsor-rejection">{c.rejectionReason}</Notice>
          )}
          {OPEN.has(c.status) && paymentsAvailable && UNPAID.has(c.billingStatus) && <PayNow campaign={c} />}
          {OPEN.has(c.status) && <EditForm campaign={c} titleMax={titleMax} blurbMax={blurbMax} />}
          {OPEN.has(c.status) && <EndCampaign campaign={c} />}
        </li>
      ))}
    </ul>
  );
}
