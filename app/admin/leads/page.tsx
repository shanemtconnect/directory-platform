import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { guardFeature } from "@/lib/features/guard";
import {
  adminBuyers, adminLeadCounts, adminRecentLeads, adminRefundQueue,
} from "@/lib/db/queries/lead-market";
import { adminDeleteLeadAction, decideRefundAction } from "@/lib/actions/leads";
import { formatCredit } from "@/lib/credits/format";
import { REFUND_REASON_LABELS } from "@/lib/leads/market";
import { AdminNav } from "@/components/admin/AdminNav";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import type { TestDb } from "@/lib/db/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leads",
  robots: { index: false, follow: false },
};

const REFUND_MESSAGES: Record<string, { variant: "success" | "error"; text: string }> = {
  approved: {
    variant: "success",
    text: "Refund approved: credited back and the buyer emailed. For a dead phone, wrong person, spam or never-asked report the phone and email are also blocklisted for 12 months.",
  },
  rejected: { variant: "success", text: "Refund rejected. The buyer has been emailed your note." },
  "note-required": { variant: "error", text: "Please say why when rejecting. The buyer is sent your note." },
  "already-decided": { variant: "error", text: "That report has already been decided." },
  "not-found": { variant: "error", text: "No such report." },
};

const pct = (rate: number) => `${Math.round(rate * 100)}%`;

function RateBadge({ rate, flagged }: { rate: number; flagged: boolean }) {
  return flagged ? (
    <span className="font-semibold" data-testid="refund-rate-flag" title="More than a third of this buyer's leads reported">
      <span aria-hidden="true">⚠ </span>
      {pct(rate)}
      <span className="sr-only"> — high refund rate</span>
    </span>
  ) : (
    <span data-testid="refund-rate">{pct(rate)}</span>
  );
}

/**
 * The lead market's console (Task 58): the counts, the bad-lead reports
 * waiting for a decision (each with its buyer's refund rate, ⚠ above a
 * third — flagged, never blocked, per D10), every buyer's rate, and the
 * recent leads with a delete. Lists carry first name and brief only; an
 * admin decides a report on the buyer's reason, not by calling the person.
 */
export default async function AdminLeadsPage({ searchParams }: { searchParams: Promise<{ refund?: string; deleted?: string }> }) {
  guardFeature("leadMarketplace");
  const viewer = await currentViewer();
  if (viewer.role !== "admin") notFound();
  const handle = db as unknown as TestDb;
  const [{ refund, deleted }, counts, queue, buyers, recent, nav] = await Promise.all([
    searchParams,
    adminLeadCounts(handle, viewer),
    adminRefundQueue(handle, viewer),
    adminBuyers(handle, viewer),
    adminRecentLeads(handle, viewer),
    adminNavCounts(handle, viewer),
  ]);
  const message = refund === undefined ? null : REFUND_MESSAGES[refund] ?? null;

  return (
    <main data-testid="admin-leads">
      <AdminNav current="/admin/leads" counts={nav} />
      <PageHeader title="Leads" lede="Open and sold leads, bad-lead reports waiting for a decision, and each buyer's refund rate." />
      {message && (
        <Notice variant={message.variant} testId="refund-decision-message">
          {message.text}
        </Notice>
      )}
      {deleted === "1" && <Notice variant="success" testId="lead-deleted-message">Lead deleted. It is off the board and out of its buyer&rsquo;s account.</Notice>}

      <dl className="mb-8 flex flex-wrap gap-6" data-testid="lead-counts">
        <div><dt className="text-muted text-sm">Open</dt><dd className="m-0 text-2xl font-semibold" data-testid="lead-count-open">{counts.open}</dd></div>
        <div><dt className="text-muted text-sm">Sold</dt><dd className="m-0 text-2xl font-semibold" data-testid="lead-count-sold">{counts.sold}</dd></div>
        <div><dt className="text-muted text-sm">Expired</dt><dd className="m-0 text-2xl font-semibold">{counts.expired}</dd></div>
        <div><dt className="text-muted text-sm">Reports waiting</dt><dd className="m-0 text-2xl font-semibold">{counts.pendingRefunds}</dd></div>
      </dl>

      <section aria-labelledby="refund-queue-heading" className="mb-10">
        <h2 id="refund-queue-heading">Bad-lead reports</h2>
        {queue.length === 0 ? (
          <EmptyState title="Nothing to decide" testId="refund-queue-empty">Reports from buyers appear here.</EmptyState>
        ) : (
          <ul className="m-0 grid list-none gap-4 p-0" data-testid="refund-queue">
            {queue.map((r) => (
              <li key={r.refundId} className="card p-4" data-testid="refund-row" data-lead-id={r.leadId}>
                <p className="m-0 font-semibold">{REFUND_REASON_LABELS[r.reason]}</p>
                {r.note && <p className="m-0">&ldquo;{r.note}&rdquo;</p>}
                <p className="text-muted m-0 text-sm">
                  {r.firstName} in {r.cityName}: {r.brief}
                </p>
                <p className="text-muted m-0 text-sm">
                  Bought {r.boughtAt.toLocaleDateString(siteConfig.locale)} for {formatCredit(r.priceCents)} by{" "}
                  {r.buyerName ?? "—"}{r.buyerEmail && ` (${r.buyerEmail})`}{r.listingName && ` for ${r.listingName}`} · refund
                  rate <RateBadge rate={r.buyer.rate} flagged={r.buyer.flagged} /> of {r.buyer.purchases}
                </p>
                <form action={decideRefundAction} className="mt-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="refundId" value={r.refundId} />
                  <label htmlFor={`note-${r.refundId}`} className="sr-only">Note to the buyer</label>
                  <input id={`note-${r.refundId}`} name="note" type="text" placeholder="Note to the buyer (required to reject)" className="min-w-64" />
                  <button type="submit" name="decision" value="approve" className="btn btn-primary" data-testid="refund-approve">
                    Approve refund
                  </button>
                  <button type="submit" name="decision" value="reject" className="btn btn-secondary" data-testid="refund-reject">
                    Reject
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="buyers-heading" className="mb-10">
        <h2 id="buyers-heading">Buyers</h2>
        {buyers.length === 0 ? (
          <EmptyState title="Nobody has bought a lead yet">Buyers appear here after their first purchase.</EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="table-cards" data-testid="lead-buyers">
              <thead>
                <tr><th scope="col">Buyer</th><th scope="col">Leads</th><th scope="col">Reported</th><th scope="col">Refund rate</th></tr>
              </thead>
              <tbody>
                {buyers.map((b) => (
                  <tr key={b.profileId}>
                    <td data-label="Buyer">{b.name ?? "—"}{b.email && <span className="text-muted"> · {b.email}</span>}</td>
                    <td data-label="Leads">{b.purchases}</td>
                    <td data-label="Reported">{b.refundRequests}</td>
                    <td data-label="Refund rate"><RateBadge rate={b.rate} flagged={b.flagged} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="recent-leads-heading">
        <h2 id="recent-leads-heading">Recent leads</h2>
        {recent.length === 0 ? (
          <EmptyState title="No leads yet">Leads appear here once a requester confirms their email.</EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="table-cards" data-testid="recent-leads">
              <thead>
                <tr><th scope="col">Lead</th><th scope="col">Status</th><th scope="col">Price</th><th scope="col"><span className="sr-only">Delete</span></th></tr>
              </thead>
              <tbody>
                {recent.map((l) => (
                  <tr key={l.id} data-testid="recent-lead-row" data-lead-id={l.id}>
                    <td data-label="Lead">
                      {l.firstName} in {l.cityName}{l.categoryName && ` · ${l.categoryName}`}
                      <span className="text-muted block text-sm">{l.brief}</span>
                    </td>
                    <td data-label="Status">
                      {l.status}{l.soldToListingName && ` to ${l.soldToListingName}`}
                      <span className="text-muted block text-sm">{l.source} · {l.createdAt.toLocaleDateString(siteConfig.locale)}</span>
                    </td>
                    <td data-label="Price">{formatCredit(l.priceCents)}</td>
                    <td data-label="Delete">
                      <form action={adminDeleteLeadAction}>
                        <input type="hidden" name="leadId" value={l.id} />
                        <button type="submit" className="btn btn-secondary">Delete</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
