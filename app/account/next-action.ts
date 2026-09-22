import type { OwnerListing, OwnerNextActions } from "@/lib/db/queries/owner";

export interface NextAction {
  label: string;
  /** Null for something the owner can only wait for. */
  href: string | null;
}

/**
 * The one thing to do next for a listing, in priority order.
 *
 * Unread enquiries always win: they are the only item with a person waiting
 * on the other end. Unanswered reviews are next — public, and read by the
 * next customer. Then what makes the page worth opening (photos), then what
 * makes it trusted (claim, verification), then the editor. A listing still
 * under review has nothing to do.
 *
 * `actions` is null when the count query could not see the listing, which
 * only happens if ownership changed between the two reads; the fallbacks
 * below still give a sensible answer.
 */
export function nextActionFor(l: OwnerListing, actions: OwnerNextActions | null): NextAction {
  if (l.unreadEnquiries > 0) {
    return {
      label: `Reply to ${l.unreadEnquiries} unread ${l.unreadEnquiries === 1 ? "enquiry" : "enquiries"}`,
      href: `/account/listings/${l.id}/enquiries`,
    };
  }
  if (l.status === "pending") {
    return { label: "Being reviewed — we will email you when it is live", href: null };
  }
  if (actions !== null && actions.unrepliedReviews > 0) {
    const n = actions.unrepliedReviews;
    return {
      label: `Reply to ${n} ${n === 1 ? "review" : "reviews"}`,
      href: `/account/listings/${l.id}/reviews`,
    };
  }
  if (actions !== null && actions.photoCount === 0) {
    return { label: "Add photos", href: `/account/listings/${l.id}/photos` };
  }
  if (l.claimStatus === "unclaimed") {
    return { label: "Claim this listing", href: `/claim/${l.id}` };
  }
  if (l.claimStatus !== "verified") {
    return { label: "Get verified", href: "/pricing" };
  }
  if (l.status !== "published") {
    return { label: "Check the details", href: `/account/listings/${l.id}` };
  }
  return { label: "Keep the description and opening hours up to date", href: `/account/listings/${l.id}` };
}
