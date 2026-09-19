"use client";

import { useActionState } from "react";
import { submitReview, type ReviewState } from "@/lib/actions/review";
import { siteConfig } from "@/config/site.config";
import { TurnstileWidget } from "@/components/submit/TurnstileWidget";
import { REVIEW_MAX, subRatingField } from "@/lib/reviews/validate";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: ReviewState = { status: "idle" };

const SCORES = [5, 4, 3, 2, 1] as const;

export interface ReviewFormProps {
  listingId: string;
  listingName: string;
  /** Null outside production; the server-side check skips in the same case. */
  turnstileSiteKey: string | null;
}

/**
 * The public review form.
 *
 * The rating is a radio group rather than a widget: it is the one field that
 * must work with no JavaScript, no pointer and a screen reader, because it is
 * the field the whole record turns on.
 *
 * The confirmation deliberately does not say the review is live. It is not —
 * nothing is published until the link in the email is clicked — and a form
 * that says "thanks, it's up" produces a complaint an hour later.
 */
export function ReviewForm({ listingId, listingName, turnstileSiteKey }: ReviewFormProps) {
  const [state, action, pending] = useActionState(submitReview, initial);

  if (state.status === "sent") {
    return (
      <Notice variant="success" testId="review-sent" title="Check your email">
        <p>
          We&rsquo;ve sent a link to confirm your email address. Your review of {listingName} goes
          live when you click it — that&rsquo;s how every review here is kept to real people.
        </p>
        <p className="mb-0">
          <strong>What happens next:</strong> the link opens a page with one Confirm button. Once
          you press it the review is published straight away, unless it contains a link, contact
          details or strong language — then a person reads it first and we email you either way.
        </p>
      </Notice>
    );
  }

  return (
    <form action={action} data-testid="review-form" className="card">
      <input type="hidden" name="listingId" value={listingId} />

      {/* Honeypot. Hidden from people and from screen readers, visible to bots. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="company_website">Leave this field empty</label>
        <input id="company_website" name="company_website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <fieldset>
        <legend>Your rating</legend>
        {SCORES.map((score) => (
          <label key={score} className="mr-4 inline-block">
            <input type="radio" name="rating" value={score} required /> {score}
          </label>
        ))}
        {state.fieldErrors?.rating && <span role="alert">{state.fieldErrors.rating}</span>}
      </fieldset>

      {siteConfig.reviewCriteria.map((criterion) => {
        const field = subRatingField(criterion.key);
        return (
          <fieldset key={criterion.key}>
            <legend>{criterion.label} (optional)</legend>
            {SCORES.map((score) => (
              <label key={score} className="mr-4 inline-block">
                <input type="radio" name={field} value={score} /> {score}
              </label>
            ))}
            {state.fieldErrors?.[field] && <span role="alert">{state.fieldErrors[field]}</span>}
          </fieldset>
        );
      })}

      <p>
        <label htmlFor="rev-title">Title (optional)</label>
        <input id="rev-title" name="title" maxLength={REVIEW_MAX.title}
          aria-invalid={Boolean(state.fieldErrors?.title)} />
        {state.fieldErrors?.title && <span role="alert">{state.fieldErrors.title}</span>}
      </p>

      <p>
        <label htmlFor="rev-body">Your review</label>
        <textarea id="rev-body" name="body" required rows={6} maxLength={REVIEW_MAX.body}
          aria-invalid={Boolean(state.fieldErrors?.body)} />
        {state.fieldErrors?.body && <span role="alert">{state.fieldErrors.body}</span>}
      </p>

      <p>
        <label htmlFor="rev-name">Name to publish this under</label>
        <input id="rev-name" name="displayName" required maxLength={REVIEW_MAX.displayName}
          aria-invalid={Boolean(state.fieldErrors?.displayName)} autoComplete="name" />
        {state.fieldErrors?.displayName && <span role="alert">{state.fieldErrors.displayName}</span>}
      </p>

      <p>
        <label htmlFor="rev-email">Email</label>
        <input id="rev-email" name="email" type="email" required maxLength={REVIEW_MAX.email}
          aria-invalid={Boolean(state.fieldErrors?.email)} autoComplete="email" />
        {state.fieldErrors?.email && <span role="alert">{state.fieldErrors.email}</span>}
        <small className="block">
          Never published and never passed on. It is only used to confirm this review is yours.
        </small>
      </p>

      <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} />

      {state.status === "error" && state.message && (
        <Notice variant="error" testId="review-error">
          {state.message}
        </Notice>
      )}

      <SubmitButton pending={pending} pendingLabel="Sending…" block>
        Submit review
      </SubmitButton>
    </form>
  );
}
