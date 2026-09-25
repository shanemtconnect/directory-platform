import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { now } from "@/lib/clock";
import { currentViewer } from "@/lib/auth/viewer";
import { boardLeads, buyerContext } from "@/lib/db/queries/lead-market";
import { buyLeadAction } from "@/lib/actions/leads";
import { formatCredit } from "@/lib/credits/format";
import { leadAge } from "@/lib/leads/market";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/pillar/Pagination";
import type { TestDb } from "@/lib/db/types";
import { RefundPolicy } from "./RefundPolicy";

/**
 * The lead board (Task 58, flag `leadMarketplace`), shared by /leads and
 * /leads/page/<n>. Signed-in only: the nav advertises it to everyone and a
 * signed-out visitor is sent to sign in and brought back.
 *
 * Each row is what a buyer may see before paying — first name, town,
 * category, the brief, its age and today's price — and never a way to reach
 * the person. The button buys it from credit; with too little credit the
 * row offers a top-up instead, so nobody presses a button that cannot work.
 */

export const leadBoardMetadata: Metadata = {
  title: "Leads",
  robots: { index: false, follow: false },
};

const BUY_MESSAGES: Record<string, { variant: "error" | "status"; text: string; topUp?: boolean }> = {
  insufficient: { variant: "error", text: "You do not have enough credit for that lead. Nothing was taken.", topUp: true },
  gone: { variant: "status", text: "Someone else bought that lead first, or it has expired. You were not charged." },
  "not-your-listing": { variant: "error", text: `Choose one of your own ${siteConfig.entity.plural} to buy the lead for. Nothing was taken.` },
};

/** The signed-out board: what leads are and where to sign in — no rows. */
function LeadBoardTeaser({ path }: { path: string }) {
  const e = siteConfig.entity;
  const next = encodeURIComponent(path);
  return (
    <main data-testid="lead-board-teaser">
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Leads"
          lede={`People looking for a ${e.singular} whose request no listed ${e.singular} could take. Sign in with the account that owns your listing to see them and buy the ones you want.`}
        >
          <p>
            <a href={`/login?next=${next}`} className="btn btn-primary" data-testid="lead-board-login">Sign in</a>{" "}
            <a href={`/signup?next=${next}`} className="btn btn-secondary">Create an account</a>
          </p>
        </PageHeader>
      </div>
    </main>
  );
}

export async function renderLeadBoard(page: number, buy: string | undefined) {
  const path = page === 1 ? "/leads" : `/leads/page/${page}`;
  const viewer = await currentViewer();
  // Signed out, the board is a 200 teaser rather than a redirect: it is an
  // advertised nav route (e2e/routes.spec.ts holds every one of those to 200),
  // and a visitor deciding whether to list their business should be able to
  // read what a lead is before they are asked to sign in.
  if (viewer.role === "public") return <LeadBoardTeaser path={path} />;

  const at = now();
  const handle = db as unknown as TestDb;
  const [board, buyer] = await Promise.all([boardLeads(handle, viewer, { page }, at), buyerContext(handle, viewer)]);
  if (page > board.pages) notFound();
  const message = buy === undefined ? null : BUY_MESSAGES[buy] ?? null;
  const e = siteConfig.entity;

  return (
    <main data-testid="lead-board">
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Leads"
          lede={`People looking for a ${e.singular} whose request no listed ${e.singular} could take. Buy a lead and you get their name, phone and email at once.`}
        >
          <p>
            Your credit:{" "}
            <strong data-testid="lead-board-balance" data-cents={buyer.balanceCents}>
              {formatCredit(buyer.balanceCents)}
            </strong>
            {" · "}
            <a href="/account/credit">Top up</a>
            {" · "}
            <a href="/account/leads">Your leads and standing orders</a>
          </p>
        </PageHeader>

        {message && (
          <Notice variant={message.variant} testId="lead-buy-message">
            {message.text} {message.topUp && <a href="/account/credit">Top up your credit</a>}
          </Notice>
        )}

        {buyer.listings.length === 0 && (
          <Notice variant="status" testId="lead-board-no-listing">
            Leads are bought for a {e.singular} on {siteConfig.name}. <a href="/account">Claim or add yours</a> to
            start buying.
          </Notice>
        )}

        {board.leads.length === 0 ? (
          <EmptyState title="No open leads right now" testId="lead-board-empty">
            New leads appear here the moment nobody&rsquo;s standing order takes them. A standing order buys them for
            you automatically: <a href="/account/leads">set one up</a>.
          </EmptyState>
        ) : (
          <ul className="m-0 grid list-none gap-4 p-0" data-testid="lead-list">
            {board.leads.map((lead) => (
              <li key={lead.id} className="card p-4" data-testid="lead-row" data-lead-id={lead.id}>
                <p className="m-0 font-semibold">
                  {lead.firstName} in {lead.cityName}
                  {lead.categoryName && <span className="text-muted"> · {lead.categoryName}</span>}
                </p>
                <p className="my-2">{lead.brief}</p>
                <p className="text-muted m-0 text-sm">
                  {leadAge(lead.createdAt, at)} ·{" "}
                  <span data-testid="lead-price" data-cents={lead.priceCents}>
                    {formatCredit(lead.priceCents)}
                  </span>
                  {lead.halfPrice && " (half price)"}
                </p>
                {buyer.listings.length > 0 &&
                  (buyer.balanceCents >= lead.priceCents ? (
                    <form action={buyLeadAction} className="mt-3 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="leadId" value={lead.id} />
                      <input type="hidden" name="page" value={page} />
                      {buyer.listings.length === 1 ? (
                        <input type="hidden" name="listingId" value={buyer.listings[0]!.id} />
                      ) : (
                        <>
                          <label htmlFor={`buy-for-${lead.id}`} className="sr-only">
                            Buy for
                          </label>
                          <select id={`buy-for-${lead.id}`} name="listingId" required>
                            {buyer.listings.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.name}
                              </option>
                            ))}
                          </select>
                        </>
                      )}
                      <button type="submit" className="btn btn-primary" data-testid="lead-buy">
                        Buy for {formatCredit(lead.priceCents)}
                      </button>
                    </form>
                  ) : (
                    <p className="mt-3">
                      <a href="/account/credit" className="btn btn-secondary" data-testid="lead-topup">
                        Top up to buy
                      </a>
                    </p>
                  ))}
              </li>
            ))}
          </ul>
        )}

        <Pagination basePath="/leads" page={board.page} totalPages={board.pages} />
        <RefundPolicy />
      </div>
    </main>
  );
}
