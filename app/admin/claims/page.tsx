import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { listPendingClaims } from "@/lib/db/queries/claims";

export const metadata: Metadata = {
  title: "Claims",
  robots: { index: false, follow: false },
};

export default async function AdminClaimsPage() {
  // The layout has already refused anybody who is not an admin; the query
  // refuses again on its own account, because a query that trusts its caller
  // is one route handler away from being the hole.
  const viewer = await currentViewer();
  const claims = await listPendingClaims(db, viewer);
  const e = siteConfig.entity;

  return (
    <main>
      <h1>Claims</h1>
      <p className="text-muted">
        {claims.length === 0
          ? "Nothing is waiting. Domain-email claims approve themselves and never appear here."
          : `${claims.length} waiting for a decision.`}
      </p>

      {claims.length > 0 && (
        <table data-testid="claims-queue">
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
                <td><a href={claim.listingPath}>{claim.listingName}</a></td>
                <td>
                  {claim.claimantName ?? "—"}
                  {claim.roleAtBusiness && <span className="text-muted"> · {claim.roleAtBusiness}</span>}
                </td>
                <td>{evidenceLabel(claim.evidenceType, claim.hasDocument)}</td>
                <td>
                  <time dateTime={claim.createdAt.toISOString()}>
                    {claim.createdAt.toLocaleDateString(siteConfig.locale)}
                  </time>
                </td>
                <td><a href={`/admin/claims/${claim.id}`}>Review</a></td>
              </tr>
            ))}
          </tbody>
        </table>
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
