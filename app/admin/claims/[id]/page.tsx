import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { getClaimForAdmin, DOCUMENT_RETENTION_DAYS } from "@/lib/db/queries/claims";
import { claimDocsConfigured } from "@/lib/media/claim-docs";
import { ClaimDecision } from "@/components/claim/ClaimDecision";

export const metadata: Metadata = {
  title: "Claim",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminClaimPage({ params }: Props) {
  const { id } = await params;
  const viewer = await currentViewer();
  const claim = await getClaimForAdmin(db, viewer, id);
  if (!claim) notFound();

  const e = siteConfig.entity;
  const date = (d: Date): string => d.toLocaleString(siteConfig.locale);

  return (
    <main>
      <p className="text-sm text-muted"><a href="/admin/claims">← Claims</a></p>
      <h1>{claim.listingName}</h1>

      <dl data-testid="claim-detail">
        <dt>{e.Singular}</dt>
        <dd><a href={claim.listingPath}>{claim.listingPath}</a></dd>

        <dt>Status</dt>
        <dd data-testid="claim-status">{claim.status}</dd>

        <dt>Claimant</dt>
        <dd>{claim.claimantName ?? "Not given"}</dd>

        <dt>Role</dt>
        <dd>{claim.roleAtBusiness ?? "Not given"}</dd>

        <dt>Business email</dt>
        <dd>{claim.businessEmail ?? "Not given"}</dd>

        <dt>Evidence</dt>
        <dd>{claim.evidenceType ?? "None"}</dd>

        {claim.evidenceNotes && (
          <>
            <dt>Notes</dt>
            <dd>{claim.evidenceNotes}</dd>
          </>
        )}

        <dt>Email confirmed</dt>
        <dd>{claim.emailVerifiedAt ? date(claim.emailVerifiedAt) : "No"}</dd>

        <dt>Opened</dt>
        <dd>{date(claim.createdAt)}</dd>

        {claim.decidedAt && (
          <>
            <dt>Decided</dt>
            <dd>{date(claim.decidedAt)}</dd>
          </>
        )}

        {claim.rejectionReason && (
          <>
            <dt>Reason given</dt>
            <dd>{claim.rejectionReason}</dd>
          </>
        )}
      </dl>

      <section aria-labelledby="documents">
        <h2 id="documents">Documents</h2>
        {claim.documentsPurgedAt !== null ? (
          <p data-testid="claim-documents-purged">
            Deleted on {date(claim.documentsPurgedAt)}, {DOCUMENT_RETENTION_DAYS} days after the
            decision.
          </p>
        ) : claim.documents.length === 0 ? (
          <p data-testid="claim-no-documents">Nothing uploaded.</p>
        ) : !claimDocsConfigured() ? (
          <p data-testid="claim-documents-unreachable">
            This claim names a document, but document storage is not configured here.
          </p>
        ) : (
          <ul data-testid="claim-documents">
            {claim.documents.map((slot) => (
              <li key={slot}>
                {/* Never a public URL. The route checks the role again, signs a
                    15-minute GET and records the view before redirecting. */}
                <a href={`/api/admin/claims/${claim.id}/document?slot=${slot}`} rel="noopener" target="_blank">
                  Open the {slot === "proof" ? "proof of business" : "identity"} document
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted">
          Every view is recorded. Documents are deleted {DOCUMENT_RETENTION_DAYS} days after the
          decision.
        </p>
      </section>

      {claim.status === "pending" ? (
        <ClaimDecision claimId={claim.id} />
      ) : (
        <p data-testid="claim-already-decided">This claim has already been decided.</p>
      )}
    </main>
  );
}
