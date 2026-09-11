import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { AUDIT_PAGE_SIZE, auditEntityTypes, recentAudit } from "@/lib/db/queries/admin/audit";
import { AdminNav } from "@/components/admin/AdminNav";
import { AuditFilter, AuditTable } from "@/components/admin/AuditTable";

export const metadata: Metadata = {
  title: "Audit log",
  robots: { index: false, follow: false },
};

/**
 * The filter, as a path. Anything that is not a type the table actually holds
 * is a 404 rather than an empty page, so a typo reads as a typo.
 */
export default async function AuditFilteredPage({
  params,
}: {
  params: Promise<{ entityType: string }>;
}) {
  const { entityType } = await params;
  const viewer = await currentViewer();
  const types = await auditEntityTypes(db, viewer);
  if (!types.includes(entityType)) notFound();

  const rows = await recentAudit(db, viewer, entityType);

  return (
    <main>
      <AdminNav current="/admin/audit" />
      <h1>Audit log</h1>
      <p className="text-muted">
        The last {AUDIT_PAGE_SIZE} changes against <strong>{entityType}</strong>.
      </p>
      <AuditFilter types={types} current={entityType} />
      <AuditTable rows={rows} />
    </main>
  );
}
