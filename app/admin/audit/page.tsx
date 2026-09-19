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

export default async function AuditPage() {
  const viewer = await currentViewer();
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse: the page and the layout render concurrently, and
  // a thrown FORBIDDEN puts a stack trace in the log for every 404.
  if (viewer.role !== "admin") notFound();
  const [rows, types, counts] = await Promise.all([
    recentAudit(db, viewer, null),
    auditEntityTypes(db, viewer),
    adminNavCounts(db, viewer),
  ]);

  return (
    <main>
      <AdminNav current="/admin/audit" counts={counts} />
      <PageHeader
        title="Audit log"
        lede={`Every admin and owner change, in the transaction that made it. The last ${AUDIT_PAGE_SIZE}.`}
      />
      <AuditFilter types={types} current={null} />
      <AuditTable rows={rows} />
    </main>
  );
}
