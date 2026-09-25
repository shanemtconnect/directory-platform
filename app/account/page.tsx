import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { ownerListings, type OwnerListing } from "@/lib/db/queries/owner";
import { ownerNextActions, ownerUnreadCount } from "@/lib/db/queries/owner";
import { nextActionFor } from "./next-action";
import { claimsForViewer } from "@/lib/db/queries/claims";
import { listingStats } from "@/lib/db/queries/stats";
import { UnverifiedEmailBanner } from "@/components/auth/UnverifiedEmailBanner";
import { SPARKLINE_BOX, sparkline } from "@/components/stats/sparkline";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { features } from "@/lib/features/flags";

export const metadata: Metadata = {
  title: "Your account",
  robots: { index: false, follow: false },
};

/** What `/claim/verify/[token]` redirected here to say. */
const CLAIM_MESSAGES: Record<string, string> = {
  approved: "Confirmed. The listing is yours — it is in the list below.",
  expired: "That link had expired. Start the claim again and we will send a fresh one.",
  "already-claimed": "Somebody else claimed that listing before the link was opened.",
  unknown: "That link is not one we recognise. It may already have been used.",
};

interface Props {
  searchParams: Promise<{ claim?: string }>;
}

/** Views over the tier's window, as a line, or null when there is nothing to draw. */
async function viewsLine(
  viewer: Parameters<typeof listingStats>[1],
  l: OwnerListing,
): Promise<{ points: string; total: number; days: number } | null> {
  const stats = await listingStats(db, viewer, l.id, siteConfig.tiers[l.tier].statsWindowDays);
  if (!stats || stats.totals.views === 0) return null;
  const line = sparkline(stats.days.map((d) => d.views));
  return line === null ? null : { points: line.points, total: stats.totals.views, days: stats.windowDays };
}

export default async function AccountPage({ searchParams }: Props) {
  const { claim } = await searchParams;
  const viewer = await currentViewer();
  const e = siteConfig.entity;

  // The layout redirects an anonymous viewer to /login, but a layout and its
  // page render concurrently, so this page must not assume the redirect ran
  // first: without its own check, ensureProfile threw on every anonymous hit
  // and the boot log filled with a stack trace for a request that was already
  // being redirected.
  if (viewer.role === "public") redirect("/login?next=/account");

  // The profile is ensured rather than read so a brand-new account has one
  // before anything tries to scope by it.
  await ensureProfile(db, viewer);
  const [listings, unread, claims] = await Promise.all([
    ownerListings(db, viewer),
    ownerUnreadCount(db, viewer),
    claimsForViewer(db, viewer),
  ]);
  const lines = await Promise.all(listings.map((l) => viewsLine(viewer, l)));
  // What the "Next" line is worked out from: unanswered reviews, photos,
  // claim and verification, per listing, through the owner-gated query.
  const actions = await Promise.all(listings.map((l) => ownerNextActions(db, viewer, l.id)));

  const message = claim === undefined ? null : CLAIM_MESSAGES[claim] ?? null;
  const openClaims = claims.filter((c) => c.status === "pending");
  const rejected = claims.filter((c) => c.status === "rejected");

  return (
    <main>
      <PageHeader
        title="Your account"
        lede={`Everything you manage on ${siteConfig.name}, and what needs you next.`}
      >
        <p data-testid="viewer-role" className="sr-only">Signed in as: {viewer.role}</p>
        <p>
          <a href="/account/settings">Account settings</a> — name, phone, password.
          {" · "}
          <a href="/account/billing">Billing</a> — your plan and payments.
          {features.savedSearches && (
            <>
              {" · "}
              <a href="/account/alerts" data-testid="alerts-link">Alerts</a> — your saved searches.
            </>
          )}
        </p>
      </PageHeader>

      <UnverifiedEmailBanner />

      {message && (
        <Notice variant={claim === "approved" ? "success" : "status"} testId="claim-outcome">
          {message}
        </Notice>
      )}

      <section aria-labelledby="your-listings">
        <h2 id="your-listings">Your {e.plural}</h2>
        {listings.length === 0 ? (
          <EmptyState
            title={`You haven’t claimed a ${e.singular} yet.`}
            testId="no-listings"
            action={{ href: "/search", label: `Find your ${e.singular}` }}
          >
            <p>
              <a href="/search">Find your {e.singular}</a> and claim it to manage the listing.
              Claiming is free, and once it is yours you can edit the details and see every
              enquiry it receives.
            </p>
          </EmptyState>
        ) : (
          <>
            {unread > 0 && (
              <Notice variant="status" testId="unread-total">
                {unread} unread {unread === 1 ? "enquiry" : "enquiries"} waiting.
              </Notice>
            )}
            <ul data-testid="owner-listings" className="dash-grid">
              {listings.map((l, i) => {
                const next = nextActionFor(l, actions[i] ?? null);
                const line = lines[i] ?? null;
                return (
                  <li key={l.id} className="card">
                    <div className="dash-card-head">
                      <h3><a href={l.path}>{l.name}</a></h3>
                    </div>
                    <p className="flex flex-wrap gap-1 text-sm text-muted">
                      <span className={l.status === "published" ? "pill pill-on" : "pill"}>
                        {l.status === "published" ? "Live" : `Status: ${l.status}`}
                      </span>
                      <span className={l.tier === "free" ? "pill" : "pill pill-primary"} data-testid="listing-tier">
                        {siteConfig.tiers[l.tier].label}
                      </span>
                      {l.claimStatus === "verified" && <span className="pill pill-on">Verified</span>}
                    </p>
                    {line !== null && (
                      <p className="mb-2 text-sm text-muted">
                        {line.total.toLocaleString(siteConfig.locale)} page{" "}
                        {line.total === 1 ? "view" : "views"} in the last {line.days} days
                        <svg
                          className="dash-spark"
                          viewBox={`0 0 ${SPARKLINE_BOX.width} ${SPARKLINE_BOX.height}`}
                          preserveAspectRatio="none"
                          aria-hidden="true"
                          focusable="false"
                          data-testid="dash-sparkline"
                        >
                          <polyline
                            points={line.points}
                            fill="none"
                            stroke="var(--color-primary)"
                            strokeWidth={2}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        </svg>
                      </p>
                    )}
                    <p className="mb-0">
                      <a href={`/account/listings/${l.id}`}>Edit details</a>
                      {" · "}
                      <a href={`/account/listings/${l.id}/photos`}>Photos</a>
                      {" · "}
                      <a href={`/account/listings/${l.id}/enquiries`}>
                        Enquiries ({l.enquiryCount})
                        {l.unreadEnquiries > 0 && ` — ${l.unreadEnquiries} unread`}
                      </a>
                    </p>
                    <p className="dash-card-next mb-0 text-sm" data-testid="next-action">
                      <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
                        Next
                      </span>
                      {next.href === null ? next.label : <a href={next.href}>{next.label}</a>}
                    </p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {openClaims.length > 0 && (
        <section aria-labelledby="open-claims">
          <h2 id="open-claims">Claims in progress</h2>
          <ul data-testid="open-claims">
            {openClaims.map((c) => (
              <li key={c.id}>
                <a href={c.listingPath}>{c.listingName}</a> — waiting. If you asked for an email
                link, open it within 30 minutes of asking.
              </li>
            ))}
          </ul>
        </section>
      )}

      {rejected.length > 0 && (
        <section aria-labelledby="declined-claims">
          <h2 id="declined-claims">Claims we could not approve</h2>
          <ul data-testid="declined-claims">
            {rejected.map((c) => (
              <li key={c.id}>
                <a href={c.listingPath}>{c.listingName}</a>
                {c.rejectionReason && <> — {c.rejectionReason}</>}
                {" "}
                <a href={`/claim/${c.listingId}`}>Try again</a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
