import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { pendingJobs } from "@/lib/db/queries/job-board";
import { guardFeature } from "@/lib/features/guard";
import { AdminNav } from "@/components/admin/AdminNav";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { JobQueue } from "@/components/jobs/JobQueue";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Jobs",
  robots: { index: false, follow: false },
};

export default async function AdminJobsPage() {
  guardFeature("jobBoard");
  const viewer = await currentViewer();
  // The layout gates this route too; repeated so a query never runs for a
  // viewer it will refuse (the page and the layout render concurrently).
  if (viewer.role !== "admin") notFound();
  const [queue, counts] = await Promise.all([pendingJobs(db, viewer), adminNavCounts(db, viewer)]);

  // The board's own count rides on this page only; the shared count map is
  // another module's and stays untouched.
  const withJobs = queue.length > 0 ? { ...counts, "/admin/jobs": queue.length } : counts;

  return (
    <main>
      <AdminNav current="/admin/jobs" counts={withJobs} />
      <PageHeader
        title="Jobs"
        lede="Vacancies waiting to go on the board: paid for, or posted free by a Verified owner. Oldest first."
      />
      <JobQueue queue={queue} />
    </main>
  );
}
