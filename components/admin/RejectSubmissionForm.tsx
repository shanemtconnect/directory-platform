"use client";

import { useActionState } from "react";
import { rejectSubmissionAction, type RejectState } from "@/lib/actions/admin";

/**
 * The only client component in the console.
 *
 * A rejection needs a reason — the submitter is emailed it — so the form needs
 * somewhere to say "you have not given one" without losing what was typed. That
 * is what `useActionState` is for; everything else here is a plain server form.
 */
const INITIAL: RejectState = { status: "idle" };

export function RejectSubmissionForm({ listingId }: { listingId: string }) {
  const [state, action, pending] = useActionState(rejectSubmissionAction, INITIAL);

  return (
    <form action={action} data-testid="reject-form">
      <input type="hidden" name="listingId" value={listingId} />
      <p>
        <label htmlFor="reason">Why is it being turned down?</label>
        <textarea
          id="reason"
          name="reason"
          required
          rows={4}
          aria-invalid={state.status === "error" ? true : undefined}
          aria-describedby={state.status === "error" ? "reject-error" : undefined}
        />
        <small>The submitter is sent this, word for word. Write it to be read.</small>
        {state.status === "error" && (
          <span role="alert" id="reject-error" data-testid="reject-error">
            {state.message}
          </span>
        )}
      </p>
      <button type="submit" disabled={pending} data-testid="reject-submit">
        {pending ? "Rejecting…" : "Reject submission"}
      </button>
    </form>
  );
}
