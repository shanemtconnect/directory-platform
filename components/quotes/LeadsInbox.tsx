"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { markQuoteLead } from "@/lib/actions/quotes";
import type { QuoteOutcome } from "@/lib/db/queries/quotes";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";

export interface InboxLead {
  id: string;
  /** ISO, so the server does not have to agree with the browser about format. */
  createdAt: string;
  cityName: string;
  categoryName: string;
  outcome: QuoteOutcome;
  contactVisible: boolean;
  job: string | null;
  requester: { name: string | null; email: string; phone: string | null } | null;
}

/**
 * The owner's quote leads.
 *
 * Won and lost are recorded, not inferred: the broadcast is later judged by
 * how many requests turned into work, and a figure nobody confirmed is a
 * figure we should not be quoting back to anyone.
 *
 * A free-tier listing sees each request as a card that says a request was
 * sent and what upgrading shows — the job and the requester, for this
 * request and every earlier one. That is the whole of the upsell and it is
 * stated as it is.
 */
export function LeadsInbox({ leads, locale }: { leads: InboxLead[]; locale: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Optimistic only for the button state; the truth arrives with the refresh.
  const [touched, setTouched] = useState<Record<string, "won" | "lost">>({});
  const e = siteConfig.entity;

  function mark(id: string, outcome: "won" | "lost"): void {
    setTouched((t) => ({ ...t, [id]: outcome }));
    startTransition(async () => {
      await markQuoteLead(id, outcome);
      router.refresh();
    });
  }

  if (leads.length === 0) {
    return (
      <EmptyState testId="no-leads" title="No quote requests yet.">
        When someone asks for quotes in your town and category, the request lands here.
      </EmptyState>
    );
  }

  const masked = leads.some((l) => !l.contactVisible);

  return (
    <>
      {masked && (
        <Notice variant="status" testId="leads-upsell" title="A request was sent to you">
          <p className="mb-0">
            Free listings are told when a request arrives. The job and the person&rsquo;s contact
            details are shown on paid plans — <a href="/pricing">upgrade</a> and every request below,
            including the ones already here, opens up.
          </p>
        </Notice>
      )}
      <ul data-testid="leads-inbox" className="link-grid">
        {leads.map((lead) => {
          const outcome = touched[lead.id] ?? lead.outcome;
          return (
            <li key={lead.id} className="card" data-testid="lead-row" data-outcome={outcome}>
              <p className="text-sm text-muted">
                <time dateTime={lead.createdAt}>{new Date(lead.createdAt).toLocaleString(locale)}</time>
                {" · "}{lead.categoryName} in {lead.cityName}
                {outcome !== "open" && <strong> · {outcome === "won" ? "Won" : "Lost"}</strong>}
              </p>
              {lead.contactVisible && lead.requester ? (
                <>
                  <p><strong>{lead.requester.name ?? "No name given"}</strong></p>
                  <p><a href={`mailto:${lead.requester.email}`}>{lead.requester.email}</a></p>
                  {lead.requester.phone && (
                    <p><a href={`tel:${lead.requester.phone.replace(/\s/g, "")}`}>{lead.requester.phone}</a></p>
                  )}
                  {lead.job && <p className="whitespace-pre-line" data-testid="lead-job">{lead.job}</p>}
                  <p className="flex gap-3">
                    {outcome !== "won" && (
                      <button type="button" className="btn" disabled={pending} onClick={() => mark(lead.id, "won")}>
                        Mark won
                      </button>
                    )}
                    {outcome !== "lost" && (
                      <button type="button" className="btn" disabled={pending} onClick={() => mark(lead.id, "lost")}>
                        Mark lost
                      </button>
                    )}
                  </p>
                </>
              ) : (
                <p data-testid="lead-masked" className="mb-0">
                  A request for a {e.singular} like yours was sent to you. Verify your listing on a
                  paid plan to see the job and the contact details.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
