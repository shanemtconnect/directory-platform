import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { listPendingClaims } from "@/lib/db/queries/claims";
import { AdminNav } from "@/components/admin/AdminNav";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = {
  title: "Claims",
  robots: { index: false, follow: false },
};

export default async function AdminClaimsPage() {
  // The layout has already refused anybody who is not an admin; the query
  // refuses again on its own account, because a query that trusts its caller
  // is one route handler away from being the hole.
  const viewer = await currentViewer();
  const [claims, counts] = await Promise.all([
    listPendingClaims(db, viewer),
    adminNavCounts(db, viewer),
  ]);
  const e = siteConfig.entity;

  return (
    <main>
      <AdminNav current="/admin/claims" counts={counts} />
      <PageHeader
        title="Claims"
        lede={`People asking to manage a ${e.singular} with a document as proof. Each one needs a person to look and decide.`}
      >
        {claims.length > 0 && <p className="text-muted">{claims.length} waiting for a decision.</p>}
      </PageHeader>

      {claims.length === 0 ? (
        <EmptyState title="Nothing is waiting." testId="claims-queue-empty">
          <p>
            A claim lands here when somebody sends a document instead of confirming by email.
            Domain-email claims approve themselves and never appear here.
          </p>
        </EmptyState>
      ) : (
        <div className="table-scroll">
          <table data-testid="claims-queue" className="table-cards">
            <thead>
              <tr>
                <th scope="col">{e.Singular}</th>
                <th scope="col">Claimant</th>
                <th scope="col">Evidence</th>
                <th scope="col">Waiting since</th>
                <th scope="col"><span className="sr-only">Review</span></th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => (
                <tr key={claim.id}>
                  <td data-label={e.Singular}><a href={claim.listingPath}>{claim.listingName}</a></td>
                  <td data-label="Claimant">
                    {claim.claimantName ?? "—"}
                    {claim.roleAtBusiness && <span className="text-muted"> · {claim.roleAtBusiness}</span>}
                  </td>
                  <td data-label="Evidence">{evidenceLabel(claim.evidenceType, claim.hasDocument)}</td>
                  <td data-label="Waiting since">
                    <time dateTime={claim.createdAt.toISOString()}>
                      {claim.createdAt.toLocaleDateString(siteConfig.locale)}
                    </time>
                  </td>
                  <td><a href={`/admin/claims/${claim.id}`} className="btn btn-secondary">Review</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function evidenceLabel(
  type: "domain_email" | "phone_otp" | "document" | "id_document" | null,
  hasDocument: boolean,
): string {
  if (type === "domain_email") return "Email link, not yet opened";
  if (type === "document" || type === "id_document") {
    return hasDocument ? "Document" : "Document not uploaded";
  }
  return "—";
}
