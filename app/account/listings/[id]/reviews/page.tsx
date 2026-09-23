import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ownerListing } from "@/lib/db/queries/owner";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Where the dashboard's "Reply to N reviews" points.
 *
 * The owner's reply box lives on the public reviews page — the
 * `OwnerReplyForm` under each review the viewer's listing has not answered
 * (components/reviews/ReviewList.tsx) — so there is no second copy of the
 * list here. This route exists so the account area has one stable address
 * for "your reviews" and sends the owner to the right public page after
 * proving, through the owner-gated query, that the listing is theirs.
 */
export default async function OwnerReviewsPage({ params }: Props) {
  const { id } = await params;
  const viewer = await currentViewer();
  const listing = await ownerListing(db, viewer, id);
  if (!listing) notFound();
  redirect(`${listing.path}/reviews`);
}
