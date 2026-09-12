import { siteConfig } from "@/config/site.config";
import type { ReviewSummary as Summary } from "@/lib/db/queries/reviews";
import { Stars } from "./Stars";
import { ReviewList } from "./ReviewList";

/**
 * The reviews block on a listing page: the average, the count, the first few,
 * and a link to the rest.
 *
 * Renders NOTHING when there are no reviews — no empty state, no "0 reviews",
 * no "Be the first to review". A rating widget showing nothing is the shape
 * this site refuses to fake, and an empty section on thousands of listings is
 * thin content on the pages least able to carry it. The invitation to write
 * one still shows, because that is a real call to action rather than a claim.
 */
export function ReviewSummary({
  summary, listingName, reviewsPath, leaveReviewPath,
}: {
  summary: Summary;
  listingName: string;
  reviewsPath: string;
  leaveReviewPath: string;
}) {
  const e = siteConfig.entity;

  if (summary.count === 0 || summary.average === null) {
    return (
      <section data-testid="reviews-empty" aria-labelledby="reviews">
        <h2 id="reviews">Reviews</h2>
        <p className="text-muted">
          No reviews yet. <a href={leaveReviewPath}>Write the first one</a> if you have used
          this {e.singular} — we confirm every reviewer&rsquo;s email address before it goes up.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="reviews-summary" aria-labelledby="reviews">
      <h2 id="reviews">Reviews</h2>
      <p data-testid="rating-summary">
        <Stars value={summary.average} />{" "}
        <span className="text-muted">
          from {summary.count} {summary.count === 1 ? "review" : "reviews"}
        </span>
      </p>

      <ReviewList reviews={summary.recent} />

      <p>
        <a href={reviewsPath} data-testid="all-reviews-link">
          Read all {summary.count} reviews of {listingName}
        </a>
        {" · "}
        <a href={leaveReviewPath}>Write a review</a>
      </p>
    </section>
  );
}
