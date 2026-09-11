import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { adminQueueCounts } from "@/lib/db/queries/admin/dashboard";
import { AdminNav } from "@/components/admin/AdminNav";
import { QueueCounts } from "@/components/admin/QueueCounts";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  const viewer = await currentViewer();
  const counts = await adminQueueCounts(db, viewer);

  return (
    <main>
      <AdminNav current="/admin" />
      <h1>Admin</h1>
      <p className="text-muted">Everything below is waiting on somebody here.</p>
      <QueueCounts counts={counts} />
    </main>
  );
}
