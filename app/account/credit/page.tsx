import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { guardFeature } from "@/lib/features/guard";
import { creditBalance, creditLedgerFor } from "@/lib/db/queries/credits";
import { topupPackCents } from "@/lib/billing/credit-topup";
import { startTopupAction } from "@/lib/actions/credits";
import { CREDIT_KIND_LABELS, formatCredit } from "@/lib/credits/format";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";

/**
 * Prepaid lead credit (Task 57, flag `leadMarketplace`): the balance, the
 * ledger that explains it, and one button per configured pack. A pack button
 * posts to `startTopupAction`, which sends the buyer to PayPal; nothing here
 * changes the balance by itself.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lead credit",
  robots: { index: false, follow: false },
};

/** What `startTopupAction` redirected here to say. */
const TOPUP_MESSAGES: Record<string, string> = {
  "not-configured": "Card payments are not set up on this site yet. Nothing has been charged.",
  "invalid-pack": "That amount is not one of the packs on offer. Please choose one of the buttons below.",
  "no-approve-url": "PayPal did not offer a payment page. Nothing has been charged; please try again.",
};

interface Props {
  searchParams: Promise<{ topup?: string }>;
}

export default async function AccountCreditPage({ searchParams }: Props) {
  guardFeature("leadMarketplace");
  const viewer = await currentViewer();
  // The layout redirects too, but it renders concurrently with this page.
  if (viewer.role === "public") redirect("/login?next=/account/credit");

  const { topup } = await searchParams;
  const profile = await ensureProfile(db, viewer);
  const [balance, ledger] = await Promise.all([
    creditBalance(db, profile.id),
    creditLedgerFor(db, viewer, profile.id),
  ]);
  const message = topup === undefined ? null : TOPUP_MESSAGES[topup] ?? null;

  return (
    <main data-testid="account-credit">
      <div className="mx-auto max-w-3xl">
        <PageHeader
          title="Lead credit"
          lede={`Prepaid credit for buying leads on ${siteConfig.name}. Top up in packs through PayPal; credit is spent on leads and is not paid back out as cash.`}
        >
          <p>
            <a href="/account">Back to your account</a>
          </p>
        </PageHeader>

        {message && (
          <Notice variant="error" testId="credit-topup-message">
            {message}
          </Notice>
        )}

        <section aria-labelledby="credit-balance-heading" className="mb-8">
          <h2 id="credit-balance-heading">Balance</h2>
          <p className="text-3xl font-semibold" data-testid="credit-balance" data-cents={balance}>
            {formatCredit(balance)}
          </p>
        </section>

        <section aria-labelledby="credit-topup-heading" className="mb-8">
          <h2 id="credit-topup-heading">Top up</h2>
          <p>Pick a pack. You approve the payment at PayPal and the credit lands as soon as it is confirmed.</p>
          <ul className="m-0 flex list-none flex-wrap gap-3 p-0" data-testid="credit-packs">
            {topupPackCents().map((cents) => (
              <li key={cents} className="m-0">
                <form action={startTopupAction}>
                  <input type="hidden" name="packCents" value={cents} />
                  <button type="submit" className="btn btn-primary" data-testid={`credit-pack-${cents}`}>
                    Add {formatCredit(cents)}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="credit-history-heading">
          <h2 id="credit-history-heading">History</h2>
          {ledger.length === 0 ? (
            <EmptyState title="No credit yet">Your top-ups and the leads you buy will be listed here.</EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table-cards" data-testid="credit-ledger">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">What</th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((row) => (
                    <tr key={row.id} data-testid="credit-ledger-row" data-kind={row.kind}>
                      <td data-label="Date">
                        <time dateTime={row.createdAt.toISOString()}>
                          {row.createdAt.toLocaleDateString(siteConfig.locale)}
                        </time>
                      </td>
                      <td data-label="What">
                        {CREDIT_KIND_LABELS[row.kind]}
                        {row.kind === "adjust" && row.note && <span className="text-muted"> · {row.note}</span>}
                      </td>
                      <td data-label="Amount">
                        {row.deltaCents > 0 ? "+" : "−"}
                        {formatCredit(Math.abs(row.deltaCents))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
