"use client";

import { useActionState } from "react";
import { useSession } from "@/lib/auth/client";
import { replyToReview, type ReplyState } from "@/lib/actions/review";
import { siteConfig } from "@/config/site.config";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: ReplyState = { ok: false };

/**
 * The owner's reply box, mounted under a review that has no reply yet.
 *
 * It renders CLIENT-side, off the session, on purpose. The reviews page is
 * ISR-cached and shared by everyone who opens it; reading the session on the
 * server would make the most-visited pages on the site render per request to
 * show a control almost nobody can use. So the form is a convenience for
 * whoever is signed in, and `replyToReview` re-proves ownership against
 * `listings.owner_id` before it writes anything — the page is not the gate.
 */
export function OwnerReplyForm({ reviewId }: { reviewId: string }) {
  const { data: session, isPending } = useSession();
  const [state, action, pending] = useActionState(replyToReview, initial);

  // Nobody signed in: no control, and no hint that one exists.
  if (isPending || !session?.user) return null;

  if (state.ok) {
    return (
      <Notice variant="success" testId="reply-sent">
        Your reply is published.
      </Notice>
    );
  }

  return (
    <form action={action} data-testid="reply-form" className="mt-3">
      <input type="hidden" name="reviewId" value={reviewId} />
      <label htmlFor={`reply-${reviewId}`} className="text-sm">
        Reply as the {siteConfig.entity.ownerNoun} (once per review)
      </label>
      <textarea id={`reply-${reviewId}`} name="body" rows={3} required minLength={10} maxLength={1000} />
      {state.message && (
        <Notice variant="error" testId="reply-error">
          {state.message}
        </Notice>
      )}
      <SubmitButton pending={pending} pendingLabel="Posting…" variant="secondary">
        Post reply
      </SubmitButton>
    </form>
  );
}
