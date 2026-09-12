"use client";

import { useActionState } from "react";
import { resendReviewVerification, type ResendState } from "@/lib/actions/review";

const initial: ResendState = { status: "idle" };

/**
 * The way out of an expired verification link.
 *
 * Without it the seven-day TTL would simply lose people: the one-review-per-
 * listing index means they cannot write it again, so a dead link with no
 * button would be the end of a review somebody actually wrote.
 *
 * The expired token is the only thing submitted. There is no address field on
 * purpose — the token proves the mailbox the first link went to, so this
 * cannot be pointed at anybody else's inbox — and the answer is the same
 * sentence whatever the server found, which is why it does not need to
 * distinguish success from "that one was already confirmed".
 */
export function ResendVerificationForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resendReviewVerification, initial);

  if (state.status === "sent") {
    return (
      <p role="status" data-testid="review-resent">
        If that review is still waiting to be confirmed, a new link is on its way to the address
        you used. It lasts seven days.
      </p>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="token" value={token} />
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Send me a new link"}
      </button>
      {state.status === "error" && state.message ? (
        <p role="alert" data-testid="review-resend-error">{state.message}</p>
      ) : null}
    </form>
  );
}
