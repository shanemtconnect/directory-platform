import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { billingConfigured } from "@/lib/billing/paypal";
import { featuredPlanIdFor } from "@/lib/billing/featured-plan";
import {
  bidHistory,
  currentFeaturedSubscription,
  describeSpotKeys,
  featuredClicksForListing,
  listingForBidding,
  recentRaiseExpiry,
  searchCities,
  spotBids,
  spotsForKeys,
  type BidHistoryEntry,
  type BidRow,
} from "@/lib/db/queries/spots";
import { leaderboardPath } from "@/lib/spots/notify";
import { formatMoney } from "@/lib/pricing";
import { UNIT_CENTS } from "@/lib/spots/rank";
import { buildSpotTable, monthlyTotalCents, spotKeysFor, type SpotTableRow } from "@/lib/spots/table";
import { BidForm } from "@/components/spots/BidForm";
import { CancelBidButton } from "@/components/spots/CancelBidButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Notice } from "@/components/ui/Notice";

/**
 * `/account/listings/[id]/featured` — the owner's bidding table.
 *
 * Scoped by the QUERY: `listingForBidding` matches `owner_id` to the profile
 * and answers null for anybody else, which is a 404 here (constraint 24).
 * Everything an owner sees about other bidders is the public part — the
 * amounts currently featured — never who they are.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Featured spots",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const GROUP_TITLES = { here: "Where you are listed", region: `Your ${siteConfig.regionLabel}`, other: "Other areas" } as const;

/** How far back the clicks column looks. */
const CLICK_DAYS = 30;

const HISTORY_LABELS: Record<string, string> = {
  "spots.bid_placed": "Bid placed",
  "spots.bid_raise_requested": "Raise requested",
  "spots.bid_lowered": "Bid lowered",
  "spots.bid_cancelled": "Bid cancelled",
  "spots.raise_withdrawn": "Raise withdrawn",
  "spots.raise_expired": "Raise expired (not approved in time)",
};

/**
 * The email's one-click link: `?bid=<spot key>&amount=<whole units>`. Only a
 * whole positive amount on a spot the table shows is honoured; anything else
 * is ignored rather than trusted.
 */
function readPrefill(query: Record<string, string | string[] | undefined>): { keyString: string; amount: number } | null {
  const keyString = String(Array.isArray(query.bid) ? query.bid[0] : (query.bid ?? "")).trim();
  const raw = String(Array.isArray(query.amount) ? query.amount[0] : (query.amount ?? "")).trim();
  if (keyString === "" || !/^\d{1,6}$/.test(raw)) return null;
  const amount = Number(raw);
  return amount > 0 ? { keyString, amount } : null;
}

export default async function FeaturedSpotsPage({ params, searchParams }: Props) {
  const { id } = await params;
  const query = await searchParams;
  const q = String(Array.isArray(query.q) ? query.q[0] : (query.q ?? "")).trim().slice(0, 80);
  const viewer = await currentViewer();
  if (viewer.role === "public") notFound();
  const profile = await ensureProfile(db, viewer);

  const listing = await listingForBidding(db, viewer, { listingId: id, profileId: profile.id });
  if (listing === null) notFound();

  const others = q === "" ? [] : await searchCities(db, viewer, q);
  const keys = spotKeysFor(listing, others);
  const spots = await spotsForKeys(db, viewer, keys.map((k) => k.key));
  const bidsBySpot = new Map<string, BidRow[]>();
  for (const spot of spots.values()) bidsBySpot.set(spot.id, await spotBids(db, viewer, spot.id));
  const areas = await describeSpotKeys(db, viewer, keys.map((k) => k.key));
  const rows = buildSpotTable({ listing, keys, spots, bidsBySpot, areas, config: siteConfig.featured });
  const subscription = await currentFeaturedSubscription(db, viewer, listing.id, profile.id);
  const expiredAt = await recentRaiseExpiry(db, viewer, { listingId: listing.id, profileId: profile.id, withinDays: 7 });
  const clicks = await featuredClicksForListing(db, viewer, { listingId: listing.id, profileId: profile.id, days: CLICK_DAYS });
  const history = await bidHistory(db, viewer, { listingId: listing.id, profileId: profile.id });
  const historyAreas = await describeSpotKeys(db, viewer, history.map((h) => h.key));
  const historyLabel = new Map(historyAreas.map((a) => [`${a.key.areaKind}:${a.key.areaId}:${a.key.categoryId ?? "-"}`, a.categoryName === null ? a.areaName : `${a.categoryName} in ${a.areaName}`]));
  const prefillRaw = readPrefill(query);
  const prefill = prefillRaw !== null && rows.some((r) => r.keyString === prefillRaw.keyString) ? prefillRaw : null;

  const e = siteConfig.entity;
  const money = (cents: number) => formatMoney(cents / UNIT_CENTS, siteConfig.locale, siteConfig.currency);
  const currencySymbol = money(0).replace(/[\d.,\s]/g, "");
  const configured = billingConfigured() && featuredPlanIdFor() !== null;
  const canBid = configured && listing.eligible;
  const total = monthlyTotalCents(rows);

  return (
    <main data-testid="featured-page">
      <PageHeader
        title={`Featured spots for ${listing.name}`}
        back={{ href: `/account/listings/${listing.id}`, label: listing.name }}
        lede={`Up to ${siteConfig.featured.positions} ${e.plural} are featured above every list. The ${siteConfig.featured.positions} highest monthly bids take the spots; if you are outbid you pay nothing for that spot and keep your ordinary place.`}
      >
        <p data-testid="monthly-total">
          Your monthly total: <strong>{money(total)}</strong>
          {subscription !== null && subscription.approveUrl !== null && (
            <>
              {" · "}
              <a href={subscription.approveUrl} data-testid="finish-approval">
                {subscription.status === "approval_pending"
                  ? "Finish approving at PayPal"
                  : "Approve the changed monthly amount at PayPal"}
              </a>
            </>
          )}
        </p>
      </PageHeader>

      {prefill !== null && (
        <Notice variant="status" testId="prefill-notice">
          The amount from your email, {money(prefill.amount * UNIT_CENTS)} a month, is filled in below for{" "}
          {rows.find((r) => r.keyString === prefill.keyString)?.areaName}. Check it and press Bid.
        </Notice>
      )}

      {expiredAt !== null && (
        <Notice variant="status" testId="raise-expired">
          A bid or raise you asked for was not approved at PayPal within a day, so it was dropped. Your
          other bids are unchanged; bid again whenever you like.
        </Notice>
      )}

      {!configured && (
        <Notice variant="status" testId="spots-unavailable">
          Featured spots are not set up on this site yet. You can see what each spot would cost, but not bid.
        </Notice>
      )}
      {configured && !listing.eligible && (
        <Notice variant="status" testId="spots-ineligible">
          {listing.reason === "not-published" && `Your ${e.singular} has to be live before it can be featured.`}
          {listing.reason === "not-verified" && `Featured spots are for Verified ${e.plural}. Complete verification first.`}
          {listing.reason === "no-subscription" && (
            <>
              Featured spots are for {e.plural} on a paid plan. <a href="/pricing">See the plans</a>.
            </>
          )}
        </Notice>
      )}

      {(["here", "region", "other"] as const).map((group) => {
        const groupRows = rows.filter((r) => r.group === group);
        if (group !== "other" && groupRows.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`spots-${group}`} data-testid={`spots-${group}`}>
            <h2 id={`spots-${group}`}>{GROUP_TITLES[group]}</h2>
            {group === "other" && (
              <form method="get" className="mb-4 flex items-end gap-2" data-testid="area-search">
                <label htmlFor="area-q">Search another town</label>
                <input id="area-q" name="q" defaultValue={q} maxLength={80} />
                <button type="submit" className="btn btn-secondary">Search</button>
              </form>
            )}
            {groupRows.length === 0 ? (
              group === "other" && q !== "" ? <p className="text-muted">No towns match that.</p> : null
            ) : (
              <table className="w-full text-sm" data-testid={`spot-table-${group}`}>
                <thead>
                  <tr>
                    <th scope="col" className="text-left">Spot</th>
                    <th scope="col" className="text-left">Featured now</th>
                    <th scope="col" className="text-left">You</th>
                    <th scope="col" className="text-left">To enter / to lead</th>
                    <th scope="col" className="text-left">Your bid</th>
                  </tr>
                </thead>
                <tbody>
                  {groupRows.map((row) => (
                    <SpotTableRowView
                      key={row.keyString}
                      row={row}
                      listingId={listing.id}
                      money={money}
                      currencySymbol={currencySymbol}
                      canBid={canBid}
                      clicks={row.spotId === null ? undefined : clicks.get(row.spotId)}
                      prefillAmount={prefill !== null && prefill.keyString === row.keyString ? prefill.amount : null}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      <section aria-labelledby="bid-history" data-testid="bid-history">
        <h2 id="bid-history">Your bid history</h2>
        {history.length === 0 ? (
          <p className="text-muted">No bids yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="text-left">When</th>
                <th scope="col" className="text-left">What</th>
                <th scope="col" className="text-left">Spot</th>
                <th scope="col" className="text-left">Amount</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <HistoryRow key={`${h.bidId}-${h.at.toISOString()}-${h.action}`} entry={h} label={historyLabel.get(`${h.key.areaKind}:${h.key.areaId}:${h.key.categoryId ?? "-"}`) ?? h.key.areaId} money={money} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-sm text-muted">
        Bids are per month and billed by PayPal as one subscription for this {e.singular}, at exactly the total of the spots you hold. Raising a bid needs your approval at PayPal before it counts (unapproved after a day, it is dropped); lowering or cancelling takes effect at once. Ties go to whoever set that amount first. If every one of your bids is outbid the subscription is paused, not cancelled — your bids keep their place and billing resumes only when one is featured again. A plan that is behind on payment may still bid while PayPal retries.
      </p>
    </main>
  );
}

function HistoryRow({ entry, label, money }: { entry: BidHistoryEntry; label: string; money: (cents: number) => string }) {
  return (
    <tr data-testid="history-row" data-action={entry.action}>
      <td>{entry.at.toLocaleDateString(siteConfig.locale, { timeZone: siteConfig.timezone, day: "numeric", month: "short", year: "numeric" })}</td>
      <td>
        {entry.action === "spots.bid_cancelled" && entry.meta.reason === "spot-closed"
          ? "Cancelled — spot closed by the site"
          : (HISTORY_LABELS[entry.action] ?? entry.action)}
      </td>
      <td>{label}</td>
      <td>{entry.amountCents === null ? "—" : money(entry.amountCents)}</td>
    </tr>
  );
}

function SpotTableRowView({
  row, listingId, money, currencySymbol, canBid, clicks, prefillAmount,
}: {
  row: SpotTableRow;
  listingId: string;
  money: (cents: number) => string;
  currencySymbol: string;
  canBid: boolean;
  /** Clicks on the featured card in this spot over the last CLICK_DAYS days (Task 45). */
  clicks?: number;
  /** The amount the email link asked to prefill, in major units, for this row only. */
  prefillAmount: number | null;
}) {
  const label = row.categoryName === null ? row.areaName : `${row.categoryName} in ${row.areaName}`;
  const you =
    row.yourAmountCents === null
      ? "—"
      : row.yourStatus === "pending"
        ? `${money(row.yourAmountCents)} (awaiting PayPal)`
        : row.yourPosition === null
          ? `${money(row.yourAmountCents)} — outbid`
          : `#${row.yourPosition} at ${money(row.yourAmountCents)}`;
  return (
    <tr data-testid="spot-row" data-spot={row.keyString} data-position={row.yourPosition ?? undefined}>
      <th scope="row" className="text-left font-normal">
        {label}
        {row.closed && <span className="pill"> closed</span>}
        {row.spotId !== null && (
          <>
            {" "}
            <a href={leaderboardPath(row.spotId)} className="text-xs text-muted" data-testid="spot-leaderboard">
              who is featured
            </a>
          </>
        )}
      </th>
      <td data-testid="spot-top">
        {row.top.length === 0 ? <span className="text-muted">nobody yet</span> : row.top.map((c) => money(c)).join(" · ")}
        <span className="text-muted"> ({row.top.length} of {row.positions})</span>
      </td>
      <td data-testid="spot-you">
        {you}
        {row.yourPendingCents !== null && <span className="text-muted"> (raising to {money(row.yourPendingCents)})</span>}
        {row.yourPosition !== null && clicks !== undefined && (
          <span className="text-muted" data-testid="spot-clicks"> · {clicks} {clicks === 1 ? "click" : "clicks"} in {CLICK_DAYS} days</span>
        )}
      </td>
      <td data-testid="spot-minimums">
        {money(row.minToEnterCents)} / {money(row.minToTakeFirstCents)}
      </td>
      <td>
        <BidForm
          listingId={listingId}
          spot={row.key}
          keyString={row.keyString}
          defaultAmount={prefillAmount ?? (row.yourAmountCents ?? row.minToEnterCents) / UNIT_CENTS}
          currencySymbol={currencySymbol}
          hasBid={row.yourAmountCents !== null}
          disabled={!canBid || row.closed}
        />
        {row.yourAmountCents !== null && row.spotId !== null && (
          <CancelBidButton listingId={listingId} spotId={row.spotId} />
        )}
      </td>
    </tr>
  );
}
