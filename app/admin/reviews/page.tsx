import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { now } from "@/lib/clock";
import { siteConfig } from "@/config/site.config";
import { currentViewer } from "@/lib/auth/viewer";
import { listReviewsAwaitingModeration } from "@/lib/db/queries/reviews";
import { AdminNav } from "@/components/admin/AdminNav";
import { ReviewQueue } from "@/components/admin/ReviewQueue";

export const metadata: Metadata = {
  title: "Reviews",
  robots: { index: false, follow: false },
};

export default async function AdminReviewsPage() {
  const viewer = await currentViewer();
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse: the page and the layout render concurrently, and
  // a thrown FORBIDDEN puts a stack trace in the log for every 404.
  if (viewer.role !== "admin") notFound();
  const reviews = await listReviewsAwaitingModeration(db, viewer);

  // One clock reading for the whole page, taken on the server. Ages worked out
  // per row in the browser would disagree with the HTML the server sent.
  const asOf = now();

  return (
    <main>
      <AdminNav current="/admin/reviews" />
      <h1>Reviews</h1>
      <p className="text-muted">
        {reviews.length === 0
          ? `Reviews the checks held after the author confirmed them land here. Publishing one puts it on the ${siteConfig.entity.singular} page and into its rating.`
          : `${reviews.length} held, newest first. Publishing puts the review on the page and into the rating; rejecting keeps it off.`}
      </p>
      <ReviewQueue reviews={reviews} now={asOf} />
    </main>
  );
}
