import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { pendingSubmissions } from "@/lib/db/queries/admin/submissions";
import { AdminNav } from "@/components/admin/AdminNav";
import { SubmissionQueue } from "@/components/admin/SubmissionQueue";

export const metadata: Metadata = {
  title: "Submissions",
  robots: { index: false, follow: false },
};

export default async function SubmissionsPage() {
  const viewer = await currentViewer();
  const queue = await pendingSubmissions(db, viewer, 1);

  return (
    <main>
      <AdminNav current="/admin/submissions" />
      <h1>Submissions</h1>
      <SubmissionQueue queue={queue} />
    </main>
  );
}
