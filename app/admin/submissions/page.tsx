import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { pendingSubmissions } from "@/lib/db/queries/admin/submissions";
import { AdminNav } from "@/components/admin/AdminNav";
import { SubmissionQueue } from "@/components/admin/SubmissionQueue";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Submissions",
  robots: { index: false, follow: false },
};

export default async function SubmissionsPage() {
  const viewer = await currentViewer();
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse: the page and the layout render concurrently, and
  // a thrown FORBIDDEN puts a stack trace in the log for every 404.
  if (viewer.role !== "admin") notFound();
  const [queue, counts] = await Promise.all([
    pendingSubmissions(db, viewer, 1),
    adminNavCounts(db, viewer),
  ]);

  return (
    <main>
      <AdminNav current="/admin/submissions" counts={counts} />
      <PageHeader
        title="Submissions"
        lede="Listings people have sent in through the add form, waiting to be approved or turned down. Oldest first."
      />
      <SubmissionQueue queue={queue} />
    </main>
  );
}
