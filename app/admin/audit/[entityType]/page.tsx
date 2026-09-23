import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { AUDIT_PAGE_SIZE, auditEntityTypes, recentAudit } from "@/lib/db/queries/admin/audit";
import { AdminNav } from "@/components/admin/AdminNav";
import { AuditFilter, AuditTable } from "@/components/admin/AuditTable";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { PageHeader } from "@/components/ui/PageHeader";

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
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse: the page and the layout render concurrently, and
  // a thrown FORBIDDEN puts a stack trace in the log for every 404.
  if (viewer.role !== "admin") notFound();
  const types = await auditEntityTypes(db, viewer);
  if (!types.includes(entityType)) notFound();

  const [rows, counts] = await Promise.all([
    recentAudit(db, viewer, entityType),
    adminNavCounts(db, viewer),
  ]);

  return (
    <main>
      <AdminNav current="/admin/audit" counts={counts} />
      <PageHeader
        title="Audit log"
        lede={
          <>
            The last {AUDIT_PAGE_SIZE} changes against <strong>{entityType}</strong>.
          </>
        }
      />
      <AuditFilter types={types} current={entityType} />
      <AuditTable rows={rows} />
    </main>
  );
}
