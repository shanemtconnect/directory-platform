"use client";

import { useActionState } from "react";
import { resendReviewVerification, type ResendState } from "@/lib/actions/review";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

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
      <Notice variant="success" testId="review-resent">
        If that review is still waiting to be confirmed, a new link is on its way to the address
        you used. It lasts seven days.
      </Notice>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="token" value={token} />
      {state.status === "error" && state.message ? (
        <Notice variant="error" testId="review-resend-error">
          {state.message}
        </Notice>
      ) : null}
      <SubmitButton pending={pending} pendingLabel="Sending…">
        Send me a new link
      </SubmitButton>
    </form>
  );
}
