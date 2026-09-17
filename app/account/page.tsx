import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { ownerListings, ownerUnreadCount } from "@/lib/db/queries/owner";
import { claimsForViewer } from "@/lib/db/queries/claims";
import { UnverifiedEmailBanner } from "@/components/auth/UnverifiedEmailBanner";

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

export default async function AccountPage({ searchParams }: Props) {
  const { claim } = await searchParams;
  const viewer = await currentViewer();
  const e = siteConfig.entity;

  // The layout has already redirected an anonymous viewer to /login. The
  // profile is ensured rather than read so a brand-new account has one before
  // anything tries to scope by it.
  await ensureProfile(db, viewer);
  const [listings, unread, claims] = await Promise.all([
    ownerListings(db, viewer),
    ownerUnreadCount(db, viewer),
    claimsForViewer(db, viewer),
  ]);

  const message = claim === undefined ? null : CLAIM_MESSAGES[claim] ?? null;
  const openClaims = claims.filter((c) => c.status === "pending");
  const rejected = claims.filter((c) => c.status === "rejected");

  return (
    <main>
      <h1>Your account</h1>
      <p data-testid="viewer-role" className="sr-only">Signed in as: {viewer.role}</p>
      <UnverifiedEmailBanner />
      <p className="text-sm text-muted">
        <a href="/account/settings">Account settings</a> — name, phone, password.
      </p>

      {message && (
        <p role="status" data-testid="claim-outcome" className="card bg-raised">{message}</p>
      )}

      <section aria-labelledby="your-listings">
        <h2 id="your-listings">Your {e.plural}</h2>
        {listings.length === 0 ? (
          <p data-testid="no-listings">
            You haven&rsquo;t claimed a {e.singular} yet.{" "}
            <a href="/search">Find your {e.singular}</a> and claim it to manage the listing.
          </p>
        ) : (
          <>
            {unread > 0 && (
              <p data-testid="unread-total">
                {unread} unread {unread === 1 ? "enquiry" : "enquiries"} waiting.
              </p>
            )}
            <ul data-testid="owner-listings" className="link-grid">
              {listings.map((l) => (
                <li key={l.id} className="card">
                  <h3 className="mt-0"><a href={l.path}>{l.name}</a></h3>
                  <p className="text-sm text-muted">
                    {l.status === "published" ? "Live" : `Status: ${l.status}`}
                    {" · "}
                    {siteConfig.tiers[l.tier].label}
                    {l.claimStatus === "verified" && " · Verified"}
                  </p>
                  <p>
                    <a href={`/account/listings/${l.id}`}>Edit details</a>
                    {" · "}
                    <a href={`/account/listings/${l.id}/enquiries`}>
                      Enquiries ({l.enquiryCount})
                      {l.unreadEnquiries > 0 && ` — ${l.unreadEnquiries} unread`}
                    </a>
                  </p>
                </li>
              ))}
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
