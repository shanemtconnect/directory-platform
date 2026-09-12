import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { pendingSubmissions } from "@/lib/db/queries/admin/submissions";
import { AdminNav } from "@/components/admin/AdminNav";
import { SubmissionQueue } from "@/components/admin/SubmissionQueue";

export const metadata: Metadata = {
  title: "Submissions",
  robots: { index: false, follow: false },
};

/**
 * Page two onwards. Page one is /admin/submissions with no suffix, so a
 * `/page/1` URL is a second address for the same list and 404s rather than
 * quietly serving it.
 */
export default async function SubmissionsPaged({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const { page } = await params;
  if (!/^[2-9][0-9]*$/.test(page)) notFound();

  const viewer = await currentViewer();
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse: the page and the layout render concurrently, and
  // a thrown FORBIDDEN puts a stack trace in the log for every 404.
  if (viewer.role !== "admin") notFound();
  const queue = await pendingSubmissions(db, viewer, Number(page));
  if (queue.page !== Number(page)) notFound();

  return (
    <main>
      <AdminNav current="/admin/submissions" />
      <h1>Submissions</h1>
      <SubmissionQueue queue={queue} />
    </main>
  );
}
