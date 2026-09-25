import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { guardFeature } from "@/lib/features/guard";
import {
  buyerContext, myPurchases, standingOrderOptions, standingOrdersFor,
} from "@/lib/db/queries/lead-market";
import {
  deleteStandingOrderAction, saveStandingOrderAction, setLeadDigestAction, setStandingOrderStatusAction,
} from "@/lib/actions/leads";
import { formatCredit } from "@/lib/credits/format";
import { MAX_STANDING_ORDERS_PER_LISTING, REFUND_REASON_LABELS, floorCents } from "@/lib/leads/market";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import type { TestDb } from "@/lib/db/types";
import { StandingOrderFields } from "./StandingOrderFields";

/**
 * /account/leads (Task 58): the leads this account bought and where each
 * refund stands, and its standing orders — the instructions that buy new
 * leads automatically. Lists show first name and brief only; the contact
 * details are on each lead's own page.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your leads",
  robots: { index: false, follow: false },
};

const ORDER_MESSAGES: Record<string, { variant: "success" | "error"; text: string }> = {
  saved: { variant: "success", text: "Standing order saved." },
  active: { variant: "success", text: "Standing order resumed. It will buy the next lead it covers." },
  paused: { variant: "success", text: "Standing order paused. It will not buy anything until you resume it." },
  deleted: { variant: "success", text: "Standing order deleted." },
  limit: { variant: "error", text: `A listing can have at most ${MAX_STANDING_ORDERS_PER_LISTING} standing orders.` },
  "not-found": { variant: "error", text: "We could not find that standing order." },
  "invalid-listing": { variant: "error", text: `Please choose one of your ${siteConfig.entity.plural}.` },
  "invalid-territories": { variant: "error", text: "Please choose at least one town, region or everywhere." },
  "invalid-categories": { variant: "error", text: "One of those categories is not on the site." },
  "invalid-price": { variant: "error", text: "Please enter a price per lead of at least the floor." },
};

const REFUND_STATUS: Record<string, string> = { pending: "Reported, being checked", approved: "Refunded", rejected: "Not refunded" };

function describePlaces(territories: { kind: string; id?: string }[], names: Map<string, string>): string {
  return territories
    .map((t) => (t.kind === "national" ? "Everywhere" : names.get(`${t.kind}:${t.id}`) ?? "A place no longer listed"))
    .join(", ");
}

export default async function AccountLeadsPage({ searchParams }: { searchParams: Promise<{ order?: string; digest?: string }> }) {
  guardFeature("leadMarketplace");
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect("/login?next=/account/leads");

  const handle = db as unknown as TestDb;
  const { order, digest } = await searchParams;
  const [purchases, orders, options, buyer] = await Promise.all([
    myPurchases(handle, viewer),
    standingOrdersFor(handle, viewer),
    standingOrderOptions(handle),
    buyerContext(handle, viewer),
  ]);
  const floor = floorCents();
  const message = order === undefined ? null : ORDER_MESSAGES[order] ?? null;
  const names = new Map<string, string>([
    ...options.regions.map((r) => [`region:${r.slug}`, r.name] as [string, string]),
    ...options.cities.map((c) => [`city:${c.id}`, c.name] as [string, string]),
  ]);
  const categoryNames = new Map(options.categories.map((c) => [c.id, c.name]));

  return (
    <main data-testid="account-leads">
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Your leads"
          lede="The leads you have bought, and the standing orders that buy new ones for you."
          back={{ href: "/account", label: "Your account" }}
        >
          <p>
            Credit: <strong>{formatCredit(buyer.balanceCents)}</strong> · <a href="/account/credit">Top up</a> ·{" "}
            <a href="/leads">The lead board</a>
          </p>
        </PageHeader>

        {message && (
          <Notice variant={message.variant} testId="order-message">
            {message.text}
          </Notice>
        )}
        {digest !== undefined && (
          <Notice variant="success" testId="digest-message">
            {digest === "on" ? "We will email you a weekly count of open leads." : "We will not email you the weekly count."}
          </Notice>
        )}

        <section aria-labelledby="purchases-heading" className="mb-10">
          <h2 id="purchases-heading">Leads you bought</h2>
          {purchases.length === 0 ? (
            <EmptyState title="No leads yet" testId="purchases-empty">
              Buy one on <a href="/leads">the board</a>, or set up a standing order below.
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table-cards" data-testid="purchases">
                <thead>
                  <tr>
                    <th scope="col">Lead</th>
                    <th scope="col">Bought</th>
                    <th scope="col">Price</th>
                    <th scope="col">Refund</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((p) => (
                    <tr key={p.purchaseId} data-testid="purchase-row" data-lead-id={p.leadId}>
                      <td data-label="Lead">
                        {p.viewable ? <a href={`/leads/${p.leadId}`}>{p.firstName} in {p.cityName}</a> : `${p.firstName} in ${p.cityName}`}
                        <span className="text-muted block text-sm">{p.brief}</span>
                      </td>
                      <td data-label="Bought">
                        <time dateTime={p.boughtAt.toISOString()}>{p.boughtAt.toLocaleDateString(siteConfig.locale)}</time>
                        <span className="text-muted block text-sm">
                          {p.viaStandingOrder ? "Standing order" : "Board"}
                          {p.listingName && ` · ${p.listingName}`}
                        </span>
                      </td>
                      <td data-label="Price">{formatCredit(p.priceCents)}</td>
                      <td data-label="Refund" data-testid="purchase-refund" data-status={p.refund?.status ?? (p.refundable ? "open" : "closed")}>
                        {p.refund
                          ? `${REFUND_STATUS[p.refund.status]} (${REFUND_REASON_LABELS[p.refund.reason].toLowerCase()})`
                          : p.refundable
                            ? <a href={`/leads/${p.leadId}#lead-report-heading`}>Report a bad lead</a>
                            : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-labelledby="orders-heading" className="mb-10">
          <h2 id="orders-heading">Standing orders</h2>
          <p>
            A standing order buys every new lead in the places and categories you choose, the moment it arrives, at
            the price you set, from your credit. When more than one order wants a lead, the highest price gets it;
            on a tie, the older order. An order pauses itself when your credit runs below its price, and we email you.
          </p>

          {orders.length > 0 && (
            <ul className="m-0 mb-6 grid list-none gap-4 p-0" data-testid="orders">
              {orders.map((o) => (
                <li key={o.id} className="card p-4" data-testid="order-row" data-status={o.status}>
                  <p className="m-0 font-semibold">
                    {o.listingName}: {formatCredit(o.priceCents)} per lead
                  </p>
                  <p className="m-0">{describePlaces(o.territories, names)}</p>
                  <p className="text-muted m-0 text-sm">
                    {o.categoryIds === null ? "Every category" : o.categoryIds.map((id) => categoryNames.get(id) ?? "—").join(", ")}
                    {" · "}
                    {o.status === "active" ? "Active" : o.pausedReason === "no_credit" ? "Paused: not enough credit" : "Paused"}
                    {" · "}
                    {o.wonCount === 1 ? "1 lead bought" : `${o.wonCount} leads bought`}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <form action={setStandingOrderStatusAction}>
                      <input type="hidden" name="orderId" value={o.id} />
                      <input type="hidden" name="status" value={o.status === "active" ? "paused" : "active"} />
                      <button type="submit" className="btn btn-secondary" data-testid="order-toggle">
                        {o.status === "active" ? "Pause" : "Resume"}
                      </button>
                    </form>
                    <form action={deleteStandingOrderAction}>
                      <input type="hidden" name="orderId" value={o.id} />
                      <button type="submit" className="btn btn-secondary">Delete</button>
                    </form>
                  </div>
                  <details className="mt-3">
                    <summary>Edit</summary>
                    <form action={saveStandingOrderAction} className="mt-3">
                      <input type="hidden" name="orderId" value={o.id} />
                      <StandingOrderFields
                        idPrefix={`order-${o.id}`}
                        options={options}
                        floorCents={floor}
                        territories={o.territories}
                        categoryIds={o.categoryIds}
                        priceCents={o.priceCents}
                      />
                      <button type="submit" className="btn btn-primary">Save changes</button>
                    </form>
                  </details>
                </li>
              ))}
            </ul>
          )}

          {buyer.listings.length === 0 ? (
            <Notice variant="status" testId="orders-no-listing">
              Standing orders belong to a {siteConfig.entity.singular} of yours that is live on {siteConfig.name}.{" "}
              <a href="/account">Claim or add one</a> first.
            </Notice>
          ) : (
            <details open={orders.length === 0} data-testid="order-new">
              <summary className="font-semibold">New standing order</summary>
              <form action={saveStandingOrderAction} className="mt-3" data-testid="order-new-form">
                <p className="mb-3">
                  <label htmlFor="order-new-listing" className="block font-semibold">
                    For
                  </label>
                  <select id="order-new-listing" name="listingId" required>
                    {buyer.listings.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </p>
                <StandingOrderFields idPrefix="order-new" options={options} floorCents={floor} />
                <button type="submit" className="btn btn-primary" data-testid="order-new-submit">
                  Save standing order
                </button>
              </form>
            </details>
          )}
        </section>

        <section aria-labelledby="digest-heading">
          <h2 id="digest-heading">Weekly email</h2>
          <form action={setLeadDigestAction} className="flex flex-wrap items-center gap-2">
            <label>
              <input type="checkbox" name="digest" defaultChecked={!buyer.digestOptOut} /> Email me once a week with
              the number of open leads in my area
            </label>
            <button type="submit" className="btn btn-secondary">Save</button>
          </form>
        </section>
      </div>
    </main>
  );
}
