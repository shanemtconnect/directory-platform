"use client";

import { useActionState } from "react";
import { updateSponsorCampaignAction, type SponsorFormState } from "@/lib/actions/sponsor";
import type { AdvertiserCampaign } from "@/lib/db/queries/ads";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: SponsorFormState = { status: "idle" };

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
}: {
  campaigns: AdvertiserCampaign[];
  titleMax: number;
  blurbMax: number;
}) {
  if (campaigns.length === 0) return null;
  return (
    <ul className="m-0 list-none p-0" data-testid="sponsor-campaigns">
      {campaigns.map((c) => (
        <li key={c.id} className="card mb-3" data-testid={`sponsor-campaign-${c.id}`} data-status={c.status}>
          <h3 className="mt-0">{c.title}</h3>
          <p className="text-sm">
            <strong>{STATUS_LABEL[c.status]}</strong>
            <span className="text-muted"> · {BILLING_LABEL[c.billingStatus]}</span>
          </p>
          <p className="text-sm text-muted">{c.blurb}</p>
          {c.status === "rejected" && c.rejectionReason !== null && (
            <Notice variant="status" testId="sponsor-rejection">{c.rejectionReason}</Notice>
          )}
          {(c.status === "pending" || c.status === "active" || c.status === "paused") && (
            <EditForm campaign={c} titleMax={titleMax} blurbMax={blurbMax} />
          )}
        </li>
      ))}
    </ul>
  );
}
