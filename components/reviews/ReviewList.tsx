import { siteConfig } from "@/config/site.config";
import type { PublicReview } from "@/lib/db/queries/reviews";
import { Stars } from "./Stars";
import { OwnerReplyForm } from "./OwnerReplyForm";

/**
 * Reads sub-ratings back out of a jsonb column.
 *
 * The criteria are per-clone (`siteConfig.reviewCriteria`), so a stored key
 * may no longer be configured and a configured key may not be in the row.
 * Neither is a fault worth throwing on a public page: iterate the CONFIG and
 * show what the row happens to have.
 */
function subRatings(value: unknown): { label: string; rating: number }[] {
  if (typeof value !== "object" || value === null) return [];
  const map = value as Record<string, unknown>;
  return siteConfig.reviewCriteria.flatMap((criterion) => {
    const rating = map[criterion.key];
    if (typeof rating !== "number" || rating < 1 || rating > 5) return [];
    return [{ label: criterion.label, rating }];
  });
}

function reviewDate(d: Date): string {
  return d.toLocaleDateString(siteConfig.locale, {
    year: "numeric", month: "long", day: "numeric",
  });
}

/**
 * `allowReplies` is off by default so the three reviews summarised on the
 * listing page do not each grow an owner control. The reviews page turns it
 * on; the action re-checks ownership either way.
 */
export function ReviewList(
  { reviews, allowReplies = false }: { reviews: PublicReview[]; allowReplies?: boolean },
) {
  const e = siteConfig.entity;

  return (
    <ol data-testid="review-list" className="list-none p-0">
      {reviews.map((review) => {
        const parts = subRatings(review.subRatings);
        return (
          <li key={review.id} data-testid="review" className="card">
            <p className="mt-0 mb-1">
              <Stars value={review.rating} />
            </p>
            {review.title && <h3 className="mt-0 mb-1">{review.title}</h3>}
            <p className="text-sm text-muted mt-0">
              {review.displayName ?? "Anonymous"}
              {" · "}
              <time dateTime={review.createdAt.toISOString()}>
                {reviewDate(review.createdAt)}
              </time>
            </p>
            {review.body && <p className="whitespace-pre-line">{review.body}</p>}

            {parts.length > 0 && (
              <ul className="text-sm text-muted list-none p-0">
                {parts.map((part) => (
                  <li key={part.label}>
                    {part.label}: <Stars value={part.rating} size="small" />
                  </li>
                ))}
              </ul>
            )}

            {review.reply && (
              <blockquote data-testid="review-reply" className="bg-raised">
                <p className="text-sm text-muted mt-0 mb-1">
                  <strong>Reply from the {e.ownerNoun}</strong>
                  {review.repliedAt && (
                    <>
                      {" · "}
                      <time dateTime={review.repliedAt.toISOString()}>
                        {reviewDate(review.repliedAt)}
                      </time>
                    </>
                  )}
                </p>
                <p className="whitespace-pre-line mb-0">{review.reply}</p>
              </blockquote>
            )}

            {allowReplies && review.reply === null && <OwnerReplyForm reviewId={review.id} />}
          </li>
        );
      })}
    </ol>
  );
}
