import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { listQuoteRequests } from "@/lib/db/queries/quotes";
import { AdminNav } from "@/components/admin/AdminNav";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { AdminQuoteList } from "@/components/quotes/AdminQuoteList";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Quote requests",
  robots: { index: false, follow: false },
};

export default async function AdminQuotesPage() {
  const viewer = await currentViewer();
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse: the page and the layout render concurrently.
  if (viewer.role !== "admin") notFound();
  const [requests, counts] = await Promise.all([
    listQuoteRequests(db, viewer),
    adminNavCounts(db, viewer),
  ]);

  return (
    <main>
      <AdminNav current="/admin/quotes" counts={counts} />
      <PageHeader
        title="Quote requests"
        lede={
          requests.length === 0
            ? "Requests sent from /get-quotes land here, newest first."
            : `${requests.length} most recent. Flag anything that is not a real request; flagged ones are hidden from owners and not sent.`
        }
      />
      <AdminQuoteList requests={requests} />
    </main>
  );
}
