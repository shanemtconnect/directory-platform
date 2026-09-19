import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { now } from "@/lib/clock";
import { siteConfig } from "@/config/site.config";
import { currentViewer } from "@/lib/auth/viewer";
import { listOpenReports } from "@/lib/db/queries/trust";
import { AdminNav } from "@/components/admin/AdminNav";
import { ReportQueue } from "@/components/admin/ReportQueue";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Reports",
  robots: { index: false, follow: false },
};

export default async function AdminReportsPage() {
  const viewer = await currentViewer();
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse: the page and the layout render concurrently, and
  // a thrown FORBIDDEN puts a stack trace in the log for every 404.
  if (viewer.role !== "admin") notFound();
  const [reports, counts] = await Promise.all([
    listOpenReports(db, viewer),
    adminNavCounts(db, viewer),
  ]);

  // One clock reading for the whole page, taken on the server. Ages worked out
  // per row in the browser would disagree with the HTML the server sent.
  const asOf = now();

  return (
    <main>
      <AdminNav current="/admin/reports" counts={counts} />
      <PageHeader
        title="Reports"
        lede={
          reports.length === 0
            ? `Corrections sent from a ${siteConfig.entity.singular} page land here.`
            : `${reports.length} open, newest first. Fix the record first, then close the report.`
        }
      />
      <ReportQueue reports={reports} now={asOf} />
    </main>
  );
}
