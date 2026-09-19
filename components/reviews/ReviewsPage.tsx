import { siteConfig } from "@/config/site.config";
import type { PublicReview } from "@/lib/db/queries/reviews";
import { Pagination } from "@/components/pillar/Pagination";
import { Stars } from "./Stars";
import { ReviewList } from "./ReviewList";

/**
 * /[city]/[listing]/reviews — every published review of one listing.
 *
 * Separate from the listing page because a business with forty reviews should
 * not push its address and its phone number below the fold, and because
 * paginated reviews need their own URLs to be crawlable at all.
 *
 * The empty state is a real page rather than a 404: the URL is linked from the
 * listing and from the review invitation, and a business with no reviews yet
 * still wants somewhere to send a customer. It is noindex — that decision is
 * made in generateMetadata, from the same count this reads.
 */
export function ReviewsPage({
  listingName, listingPath, cityName, cityPath, reviews, total, average,
  page, totalPages, basePath, leaveReviewPath,
}: {
  listingName: string;
  listingPath: string;
  cityName: string;
  cityPath: string;
  reviews: PublicReview[];
  total: number;
  average: number | null;
  page: number;
  totalPages: number;
  basePath: string;
  leaveReviewPath: string;
}) {
  const e = siteConfig.entity;

  return (
    <main>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
        <a href="/">Home</a> › <a href={cityPath}>{cityName}</a> ›{" "}
        <a href={listingPath}>{listingName}</a> › <span>Reviews</span>
      </nav>

      <h1>Reviews of {listingName}</h1>

      {total > 0 && average !== null ? (
        <p data-testid="rating-summary">
          <Stars value={average} />{" "}
          <span className="text-muted">
            from {total} {total === 1 ? "review" : "reviews"}
          </span>
          {page > 1 && <span className="text-muted"> — page {page}</span>}
        </p>
      ) : (
        <p data-testid="reviews-empty" className="text-muted">
          Nobody has reviewed this {e.singular} yet.
        </p>
      )}

      <p>
        <a href={leaveReviewPath} data-testid="leave-review-link">Write a review</a>
        {" · "}
        <a href={listingPath}>Back to {listingName}</a>
      </p>

      {reviews.length > 0 && <ReviewList reviews={reviews} allowReplies />}

      <Pagination basePath={basePath} page={page} totalPages={totalPages} />

      <p className="mt-10">
        <small>
          Every review here was written by someone who confirmed their email address. We never
          write, buy or seed reviews, and we do not remove one for being critical.
        </small>
      </p>
    </main>
  );
}
