"use client";

import { useActionState } from "react";
import { siteConfig } from "@/config/site.config";
import {
  approveSponsorAction,
  endSponsorAction,
  pauseSponsorAction,
  rejectSponsorAction,
  resumeSponsorAction,
  type SponsorQueueState,
} from "@/lib/actions/admin-sponsors";
import { SPONSOR_REJECTION_MIN_LENGTH, type AdminSponsorCampaign } from "@/lib/db/queries/ads";
import { sponsorInitial } from "@/lib/ads/initial";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { SubmitButton } from "@/components/ui/SubmitButton";

const INITIAL: SponsorQueueState = { status: "idle" };

const BILLING_PILL: Record<AdminSponsorCampaign["billingStatus"], { label: string; paid: boolean }> = {
  none: { label: "no card", paid: false },
  approval_pending: { label: "NOT PAID", paid: false },
  active: { label: "paid", paid: true },
  past_due: { label: "payment overdue", paid: true },
  cancelled: { label: "cancelled — runs out", paid: true },
  suspended: { label: "suspended", paid: false },
  expired: { label: "expired", paid: false },
};

function when(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, { dateStyle: "medium", timeZone: siteConfig.timezone }).format(value);
}

/** The card exactly as a reader would see it, minus the live link. */
function Preview({ c, logoUrl }: { c: AdminSponsorCampaign; logoUrl: string | null }) {
  return (
    <div className="card sponsor-card max-w-xs" data-testid="sponsor-preview">
      {logoUrl !== null ? (
        <img src={logoUrl} alt="" width={48} height={48} className="sponsor-logo" />
      ) : (
        <span className="sponsor-logo sponsor-initial" aria-hidden="true">{sponsorInitial(c.name)}</span>
      )}
      <span className="sponsor-label">Sponsored</span>
      <strong className="sponsor-title">{c.title}</strong>
      <span className="sponsor-blurb">{c.blurb}</span>
      <span className="sponsor-name">{c.name}</span>
    </div>
  );
}

function SponsorRow({ c, logoUrl }: { c: AdminSponsorCampaign; logoUrl: string | null }) {
  const [approved, approve, approving] = useActionState(approveSponsorAction, INITIAL);
  const [rejected, reject, rejecting] = useActionState(rejectSponsorAction, INITIAL);
  const [paused, pause, pausing] = useActionState(pauseSponsorAction, INITIAL);
  const [resumed, resume, resuming] = useActionState(resumeSponsorAction, INITIAL);
  const [ended, end, ending] = useActionState(endSponsorAction, INITIAL);
  const states = [approved, rejected, paused, resumed, ended];
  const failure = states.find((s) => s.status === "error")?.message ?? null;
  const warning = states.find((s) => s.status === "done" && s.warning !== undefined)?.warning ?? null;
  const done = states.some((s) => s.status === "done");
  const billing = BILLING_PILL[c.billingStatus];
  const titleId = `sponsor-${c.id}-title`;
  const hidden = <input type="hidden" name="campaignId" value={c.id} />;

  return (
    <li className="card mb-3" data-testid={`sponsor-${c.id}`} data-status={c.status}>
      <h2 className="mt-0 text-lg" id={titleId}>
        {c.name} <span className="pill">{c.status}</span>{" "}
        <span
          className={billing.paid ? "pill" : "pill pill-danger"}
          data-testid="sponsor-billing-pill"
          data-billing={c.billingStatus}
        >
          {billing.label}
        </span>
      </h2>
      <p className="text-sm text-muted">
        Submitted {when(c.createdAt)} by{" "}
        {c.advertiserEmail !== null ? <a href={`mailto:${c.advertiserEmail}`}>{c.advertiserEmail}</a> : "an account with no email"}
        {" · "}billing: {c.billingStatus}
        {c.currentPeriodEnd !== null && ` to ${when(c.currentPeriodEnd)}`}
      </p>
      <Preview c={c} logoUrl={logoUrl} />
      <dl className="kv mt-3">
        <dt>Links to</dt>
        <dd><a href={c.targetUrl} rel="nofollow noreferrer" target="_blank">{c.targetUrl}</a></dd>
        <dt>Placements</dt>
        <dd>{c.placements.join(", ")}</dd>
      </dl>
      {failure !== null && <Notice variant="error" testId="sponsor-decision-error">{failure}</Notice>}
      {done && failure === null && warning !== null && (
        <Notice variant="status" testId="sponsor-decision-warning" title="Done, with a catch">{warning}</Notice>
      )}
      {done && failure === null && warning === null && (
        <Notice variant="success" testId="sponsor-decision-done">Done — the queue updates on the next load.</Notice>
      )}
      {c.status === "pending" && c.billingStatus === "approval_pending" && (
        <p className="text-sm text-muted" data-testid="sponsor-unpaid-note">
          Not paid yet: approving it will not show it until PayPal confirms the subscription.
        </p>
      )}
      {c.status === "pending" && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm">Turn it down</summary>
          <form action={reject}>
            {hidden}
            <label className="block text-sm" htmlFor={`reason-${c.id}`}>Why — the advertiser reads this</label>
            <textarea id={`reason-${c.id}`} name="reason" required minLength={SPONSOR_REJECTION_MIN_LENGTH} rows={3} className="mb-2 block w-full" data-testid="sponsor-reject-reason" />
            <SubmitButton pending={rejecting} pendingLabel="Saving…" variant="secondary" testId="sponsor-reject">Reject</SubmitButton>
          </form>
        </details>
      )}
      <div className="action-bar" role="group" aria-labelledby={titleId}>
        {(c.status === "pending" || c.status === "paused") && (
          <form action={c.status === "pending" ? approve : resume}>
            {hidden}
            <SubmitButton pending={approving || resuming} pendingLabel="Saving…" testId="sponsor-approve">
              {c.status === "pending" ? "Approve" : "Resume"}
            </SubmitButton>
          </form>
        )}
        {c.status === "active" && (
          <form action={pause}>
            {hidden}
            <SubmitButton pending={pausing} pendingLabel="Saving…" variant="secondary" testId="sponsor-pause">Pause</SubmitButton>
          </form>
        )}
        <form action={end}>
          {hidden}
          <SubmitButton pending={ending} pendingLabel="Saving…" variant="secondary" testId="sponsor-end">End</SubmitButton>
        </form>
      </div>
    </li>
  );
}

export function SponsorQueue({
  campaigns,
  logoUrls,
}: {
  campaigns: AdminSponsorCampaign[];
  /** campaign id → public logo URL, resolved on the server. */
  logoUrls: Record<string, string>;
}) {
  if (campaigns.length === 0) {
    return (
      <EmptyState title="No sponsor campaigns are waiting." testId="sponsor-queue-empty">
        <p>Campaigns submitted at /advertise/sponsor land here.</p>
      </EmptyState>
    );
  }
  return (
    <ul className="m-0 list-none p-0" data-testid="sponsor-queue">
      {campaigns.map((c) => (
        <SponsorRow key={c.id} c={c} logoUrl={logoUrls[c.id] ?? null} />
      ))}
    </ul>
  );
}
