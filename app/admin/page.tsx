import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { adminQueueCounts } from "@/lib/db/queries/admin/dashboard";
import { AdminNav } from "@/components/admin/AdminNav";
import { QueueCounts } from "@/components/admin/QueueCounts";
import { navCountsFrom } from "@/components/admin/nav-counts";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  const viewer = await currentViewer();
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse: the page and the layout render concurrently, and
  // a thrown FORBIDDEN puts a stack trace in the log for every 404.
  if (viewer.role !== "admin") notFound();
  const counts = await adminQueueCounts(db, viewer);

  return (
    <main>
      <AdminNav current="/admin" counts={navCountsFrom(counts)} />
      <PageHeader title="Admin" lede="Everything below is waiting on somebody here." />
      <QueueCounts counts={counts} />
    </main>
  );
}
