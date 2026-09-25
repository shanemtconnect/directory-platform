import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { guardFeature } from "@/lib/features/guard";
import { creditBalances } from "@/lib/db/queries/credits";
import { adminAdjustAction } from "@/lib/actions/credits";
import { formatCredit } from "@/lib/credits/format";
import { AdminNav } from "@/components/admin/AdminNav";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Lead credit",
  robots: { index: false, follow: false },
};

/** What `adminAdjustAction` redirected here to say. */
const ADJUST_MESSAGES: Record<string, { variant: "success" | "error"; text: string }> = {
  adjusted: { variant: "success", text: "Adjusted. The entry is on the account's ledger and in the audit log." },
  "note-required": { variant: "error", text: "Please give a reason. Every adjustment carries one." },
  "invalid-amount": { variant: "error", text: "Please enter an amount other than zero, to the penny at most." },
  "would-go-negative": { variant: "error", text: "That would take the balance below zero. Nothing was changed." },
  "unknown-account": { variant: "error", text: "No account matches that. Nothing was changed." },
};

function AdjustFields({ idPrefix }: { idPrefix: string }) {
  return (
    <>
      <label htmlFor={`${idPrefix}-amount`} className="sr-only">Amount ({siteConfig.currency}, negative to remove)</label>
      <input id={`${idPrefix}-amount`} name="amount" type="number" step="0.01" required placeholder="e.g. 10 or -10" className="w-32" />
      <label htmlFor={`${idPrefix}-note`} className="sr-only">Reason</label>
      <input id={`${idPrefix}-note`} name="note" type="text" required placeholder="Reason" />
      <button type="submit" className="btn btn-secondary">Adjust</button>
    </>
  );
}

/**
 * Every account holding lead credit, and the one place credit is changed by
 * hand: an adjustment with a reason, on the ledger and audited as
 * `credit.adjusted`. The action re-checks the role (the layout is not a
 * boundary for it).
 */
export default async function AdminCreditPage({ searchParams }: { searchParams: Promise<{ adjust?: string }> }) {
  guardFeature("leadMarketplace");
  const viewer = await currentViewer();
  if (viewer.role !== "admin") notFound();
  const [{ adjust }, balances, counts] = await Promise.all([searchParams, creditBalances(db, viewer), adminNavCounts(db, viewer)]);
  const message = adjust === undefined ? null : ADJUST_MESSAGES[adjust] ?? null;

  return (
    <main>
      <AdminNav current="/admin/credit" counts={counts} />
      <PageHeader
        title="Lead credit"
        lede="Prepaid balances, largest first. Credit is only ever cashed out or corrected here, with a reason."
      />
      {message && (
        <Notice variant={message.variant} testId="credit-adjust-message">
          {message.text}
        </Notice>
      )}

      <section aria-labelledby="adjust-any-heading" className="mb-8">
        <h2 id="adjust-any-heading">Adjust any account</h2>
        <form action={adminAdjustAction} className="flex flex-wrap items-end gap-2" data-testid="credit-adjust-by-email">
          <label htmlFor="adjust-email" className="sr-only">Account email</label>
          <input id="adjust-email" name="email" type="email" required placeholder="Account email" />
          <AdjustFields idPrefix="adjust-any" />
        </form>
      </section>

      {balances.length === 0 ? (
        <EmptyState title="Nobody holds credit yet">Accounts appear here after their first top-up or adjustment.</EmptyState>
      ) : (
        <div className="table-scroll">
          <table className="table-cards" data-testid="credit-balances">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Balance</th>
                <th scope="col">Last entry</th>
                <th scope="col">Adjust</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.profileId} data-testid="credit-balance-row">
                  <td data-label="Account">
                    {b.name ?? "—"}
                    {b.email && <span className="text-muted"> · {b.email}</span>}
                  </td>
                  <td data-label="Balance">{formatCredit(b.balanceCents)}</td>
                  <td data-label="Last entry">
                    <time dateTime={b.lastEntryAt.toISOString()}>{b.lastEntryAt.toLocaleDateString(siteConfig.locale)}</time>
                  </td>
                  <td data-label="Adjust">
                    <form action={adminAdjustAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="userId" value={b.profileId} />
                      <AdjustFields idPrefix={`adjust-${b.profileId}`} />
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
