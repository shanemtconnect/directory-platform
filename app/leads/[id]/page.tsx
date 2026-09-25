import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { guardFeature } from "@/lib/features/guard";
import { purchasedLead } from "@/lib/db/queries/lead-market";
import { reportLeadAction } from "@/lib/actions/leads";
import { formatCredit } from "@/lib/credits/format";
import { REFUND_REASONS, REFUND_REASON_LABELS } from "@/lib/leads/market";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import type { TestDb } from "@/lib/db/types";

/**
 * /leads/<id> — a bought lead, in full, for its buyer (Task 58). One of the
 * two places a sold lead's contact details are ever shown (the other is the
 * won email). Anyone else — another account, an id that does not exist, a
 * lead not bought — gets the same 404, so the URL says nothing.
 *
 * Within `refundWindowDays` of buying, the buyer can report a bad lead for
 * one of the D10 reasons; after that, or once reported, the page says where
 * the report stands.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your lead",
  robots: { index: false, follow: false },
};

const REPORT_MESSAGES: Record<string, { variant: "success" | "error"; text: string }> = {
  requested: { variant: "success", text: "Thanks — we will look at it and email you the outcome." },
  "invalid-reason": { variant: "error", text: "Please choose one of the reasons listed." },
  "already-reported": { variant: "error", text: "This lead has already been reported." },
  "window-closed": { variant: "error", text: `Reports can only be made within ${siteConfig.leads.refundWindowDays} days of buying the lead.` },
  "not-found": { variant: "error", text: "We could not find that purchase." },
};

const REFUND_STATUS: Record<string, string> = {
  pending: "Reported — waiting for us to check it.",
  approved: "Refunded to your lead credit.",
  rejected: "Not refunded.",
};

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ report?: string }>;
}

export default async function LeadPage({ params, searchParams }: Props) {
  guardFeature("leadMarketplace");
  const { id } = await params;
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect(`/login?next=${encodeURIComponent(`/leads/${id}`)}`);

  const lead = await purchasedLead(db as unknown as TestDb, viewer, id);
  if (lead === null) notFound();
  const { report } = await searchParams;
  const message = report === undefined ? null : REPORT_MESSAGES[report] ?? null;
  const place = lead.categoryName === null ? lead.cityName : `${lead.cityName} · ${lead.categoryName}`;

  return (
    <main data-testid="lead-detail">
      <div className="mx-auto max-w-2xl">
        <PageHeader
          title={`${lead.name} in ${lead.cityName}`}
          lede={`You bought this lead on ${lead.boughtAt.toLocaleDateString(siteConfig.locale)} for ${formatCredit(lead.priceCents)}.`}
          back={{ href: "/account/leads", label: "Your leads" }}
        />
        {message && (
          <Notice variant={message.variant} testId="lead-report-message">
            {message.text}
          </Notice>
        )}

        <dl className="mb-8" data-testid="lead-contact">
          <dt className="font-semibold">Name</dt>
          <dd data-testid="lead-name">{lead.name}</dd>
          <dt className="font-semibold">Phone</dt>
          <dd data-testid="lead-phone">{lead.phone ? <a href={`tel:${lead.phone.replace(/\s+/g, "")}`}>{lead.phone}</a> : "Not given"}</dd>
          <dt className="font-semibold">Email</dt>
          <dd data-testid="lead-email">
            <a href={`mailto:${lead.email}`}>{lead.email}</a>
          </dd>
          <dt className="font-semibold">Where</dt>
          <dd>{place}</dd>
          <dt className="font-semibold">What they asked for</dt>
          <dd className="whitespace-pre-line" data-testid="lead-message">{lead.message}</dd>
        </dl>

        <section aria-labelledby="lead-report-heading">
          <h2 id="lead-report-heading">Report a bad lead</h2>
          {lead.refund !== null ? (
            <p data-testid="lead-refund-status" data-status={lead.refund.status}>
              {REFUND_REASON_LABELS[lead.refund.reason]}. {REFUND_STATUS[lead.refund.status]}
              {lead.refund.decisionNote && <span className="text-muted"> {lead.refund.decisionNote}</span>}
            </p>
          ) : lead.refundable ? (
            <form action={reportLeadAction} data-testid="lead-report-form">
              <input type="hidden" name="leadId" value={lead.leadId} />
              <fieldset>
                <legend>
                  What was wrong? Refunds go back to your credit. See the <a href="/leads#lead-refunds-heading">refund policy</a>.
                </legend>
                {REFUND_REASONS.map((r) => (
                  <p key={r.value} className="m-0">
                    <label>
                      <input type="radio" name="reason" value={r.value} required /> {r.label}
                    </label>
                  </p>
                ))}
              </fieldset>
              <label htmlFor="lead-report-note" className="mt-3 block">
                Anything we should know (optional)
              </label>
              <textarea id="lead-report-note" name="note" rows={3} maxLength={1000} className="w-full" />
              <p>
                <button type="submit" className="btn btn-secondary" data-testid="lead-report-submit">
                  Report this lead
                </button>
              </p>
            </form>
          ) : (
            <p className="text-muted">
              Reports can be made within {siteConfig.leads.refundWindowDays} days of buying a lead, and that time has passed.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
