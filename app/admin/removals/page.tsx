import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { now } from "@/lib/clock";
import { currentViewer } from "@/lib/auth/viewer";
import { listOpenRemovalRequests } from "@/lib/db/queries/trust";
import { AdminNav } from "@/components/admin/AdminNav";
import { RemovalQueue } from "@/components/admin/RemovalQueue";

export const metadata: Metadata = {
  title: "Removal requests",
  robots: { index: false, follow: false },
};

export default async function AdminRemovalsPage() {
  const viewer = await currentViewer();
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse: the page and the layout render concurrently, and
  // a thrown FORBIDDEN puts a stack trace in the log for every 404.
  if (viewer.role !== "admin") notFound();
  const requests = await listOpenRemovalRequests(db, viewer);

  // One clock reading for the whole page, taken on the server, so "overdue"
  // means the same thing on every row and in the HTML the server sent.
  const asOf = now();
  const overdue = requests.filter((r) => r.dueAt !== null && r.dueAt.getTime() < asOf.getTime());

  return (
    <main>
      <AdminNav current="/admin/removals" />
      <h1>Removal requests</h1>
      <p className="text-muted">
        {requests.length === 0
          ? "Nothing is waiting to come down."
          : `${requests.length} open, ${overdue.length} past the five-working-day deadline. Nearest deadline first.`}
      </p>
      <RemovalQueue requests={requests} now={asOf} />
    </main>
  );
}
