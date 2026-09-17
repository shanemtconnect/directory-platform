"use client";

import { useActionState } from "react";
import { siteConfig } from "@/config/site.config";
import { Stars } from "@/components/reviews/Stars";
import { age } from "@/components/admin/ReportQueue";
import { publishReviewAction, rejectReviewAction } from "@/lib/actions/admin-reviews";
import type { QueueState } from "@/lib/actions/admin-trust";
import type { ReviewAwaitingModeration } from "@/lib/db/queries/reviews";

/**
 * Every review the heuristics held after its author confirmed it, newest first.
 *
 * A client component for the same reason as the report queue: two admins can
 * be looking at this at once, and `useActionState` gives a row somewhere to
 * say "that one is already decided" instead of a redirect back to a queue the
 * row has vanished from, which looks exactly like success.
 *
 * What is shown is what a reader would see if it were published — the rating,
 * the words, the display name — plus why it was held. The author's address is
 * not here; it is not in the query's projection either.
 */

const INITIAL: QueueState = { status: "idle" };

/** Why the heuristics held it, in words. Falls back to the code for a reason this build does not know. */
const HELD_REASONS: Record<string, string> = {
  "too-short": "Too short to say anything",
  "contact-details": "Contains contact details",
  link: "Contains a link",
  profanity: "Contains profanity",
  shouting: "Written in capitals",
};

function when(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: siteConfig.timezone,
  }).format(value);
}

function ReviewCard({ review, now }: { review: ReviewAwaitingModeration; now: Date }) {
  const [published, publish, publishing] = useActionState(publishReviewAction, INITIAL);
  const [rejected, reject, rejecting] = useActionState(rejectReviewAction, INITIAL);
  const failure =
    (published.status === "error" ? published.message : null) ??
    (rejected.status === "error" ? rejected.message : null) ??
    null;
  const reason =
    review.flaggedReason === null
      ? null
      : (HELD_REASONS[review.flaggedReason] ?? review.flaggedReason);

  return (
    <li className="card mb-3" data-testid={`review-${review.id}`}>
      <h2 className="mt-0 text-lg">
        <a href={review.listingPath}>{review.listingName}</a>
      </h2>
      <p className="text-sm text-muted">
        <Stars value={review.rating} size="small" />{" "}
        <span data-testid="review-rating">{review.rating} of 5</span> ·{" "}
        <span data-testid="review-author">{review.displayName ?? "No name given"}</span> ·{" "}
        <time dateTime={review.createdAt.toISOString()} title={when(review.createdAt)}>
          {age(review.createdAt, now)}
        </time>
      </p>

      {review.title !== null && review.title !== "" && (
        <p className="font-semibold" data-testid="review-title">
          {review.title}
        </p>
      )}
      {review.body === null || review.body === "" ? (
        <p className="text-muted">No text was written.</p>
      ) : (
        <p className="whitespace-pre-line" data-testid="review-body">
          {review.body}
        </p>
      )}

      {reason !== null && (
        <p className="text-sm" data-testid="review-held-reason">
          Held: <strong className="text-ink">{reason}</strong>
        </p>
      )}

      <p className="text-sm">
        <a href={`/admin/submissions/${review.listingId}`}>Open the record</a> ·{" "}
        <a href={`${review.listingPath}/reviews`}>See the published reviews</a>
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <form action={publish}>
          <input type="hidden" name="reviewId" value={review.id} />
          <button type="submit" disabled={publishing} data-testid="review-publish">
            {publishing ? "Saving…" : "Publish"}
          </button>
        </form>
        <form action={reject}>
          <input type="hidden" name="reviewId" value={review.id} />
          <button type="submit" disabled={rejecting} data-testid="review-reject">
            {rejecting ? "Saving…" : "Reject"}
          </button>
        </form>
      </div>

      {failure !== null && (
        <p role="alert" className="mt-2 text-sm" data-testid="review-error">
          {failure}
        </p>
      )}
    </li>
  );
}

export function ReviewQueue({
  reviews,
  now,
}: {
  reviews: ReviewAwaitingModeration[];
  now: Date;
}) {
  if (reviews.length === 0) {
    return (
      <p data-testid="review-queue-empty">
        Nothing is held. A review lands here when its author has confirmed it and the checks
        want a person to look before it goes on a {siteConfig.entity.singular} page.
      </p>
    );
  }

  return (
    <ul className="m-0 list-none p-0" data-testid="review-queue">
      {reviews.map((review) => (
        <ReviewCard key={review.id} review={review} now={now} />
      ))}
    </ul>
  );
}
