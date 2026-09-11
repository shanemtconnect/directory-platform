import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { getClaimableListing } from "@/lib/db/queries/claims";
import { domainOfWebsite } from "@/lib/claims/domain";
import { claimDocsConfigured } from "@/lib/media/claim-docs";
import { DomainClaimForm } from "@/components/claim/DomainClaimForm";
import { DocumentClaimForm } from "@/components/claim/DocumentClaimForm";

/**
 * `/claim/<listingId>` — the evidence ladder.
 *
 * Addressed by id rather than by city and slug on purpose. A slug pair is
 * ambiguous across cities and, worse, it MOVES: a renamed listing would leave
 * every claim link anyone has been sent pointing at a 301 or a 404. The id is
 * the one handle that never changes.
 *
 * Per-request by definition — it reads the session — so no revalidate and no
 * static params.
 */

export const metadata: Metadata = {
  title: `Claim your ${siteConfig.entity.singular}`,
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ listing: string }>;
}

export default async function ClaimPage({ params }: Props) {
  const { listing: listingId } = await params;
  const viewer = await currentViewer();
  if (viewer.role === "public") {
    redirect(`/login?next=${encodeURIComponent(`/claim/${listingId}`)}`);
  }

  const listing = await getClaimableListing(db, viewer, listingId);
  if (!listing) notFound();

  const e = siteConfig.entity;
  const domain = domainOfWebsite(listing.website);

  if (listing.claimStatus !== "unclaimed") {
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <h1>{listing.name} is already claimed</h1>
          <p>
            Someone has already proved they manage this {e.singular}. If that is wrong, tell us and
            we will look into it.
          </p>
          <p data-testid="claim-taken-links">
            <a href={`/report/${listing.id}`}>Report a problem with this listing</a>
            {" · "}
            <a href={listing.path}>View the {e.singular}</a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="mx-auto max-w-2xl">
        <h1>Claim {listing.name}</h1>
        <p className="text-muted">
          Claiming is free. Once it is yours you can edit the details and see every enquiry the
          listing receives.
        </p>

        {domain === null ? (
          <p data-testid="claim-no-domain">
            This listing has no website on file, so we cannot confirm you by email.
            {claimDocsConfigured()
              ? " Send a document instead and someone will check it."
              : ` Email ${siteConfig.supportEmail} and we will sort it out with you.`}
          </p>
        ) : (
          <DomainClaimForm listingId={listing.id} domain={domain} />
        )}

        {claimDocsConfigured() ? (
          <DocumentClaimForm listingId={listing.id} />
        ) : (
          <p data-testid="claim-documents-unavailable" className="text-muted text-sm">
            Sending a document is not available on this site yet. If the email route will not work
            for you, write to <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
          </p>
        )}

        <p className="text-sm text-muted">
          <a href={listing.path}>Back to {listing.name}</a>
        </p>
      </div>
    </main>
  );
}
