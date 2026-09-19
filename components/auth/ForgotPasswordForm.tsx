"use client";

import { useActionState } from "react";
import {
  requestPasswordResetAction,
  type ForgotPasswordState,
} from "@/app/forgot-password/actions";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: ForgotPasswordState = { status: "idle" };

/**
 * The form still submits with JavaScript off: `action` is the server action
 * itself, not a handler that calls it. This is the page people reach when
 * something has already gone wrong for them, so it is the last place to make
 * a working bundle a precondition.
 */
export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordResetAction, initial);

  if (state.status === "sent") {
    return (
      <Notice variant="success" testId="forgot-password-sent" title="What happens next">
        <p>{state.message}</p>
        <p className="mb-0">
          The link in the email works once and for an hour, and opens a page where you type the
          new password twice. Nothing in your inbox after a few minutes? Check the spam folder,
          then <a href="/forgot-password">try again</a>.
        </p>
      </Notice>
    );
  }

  return (
    <form action={action} data-testid="forgot-password-form" className="card max-w-md">
      <p>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
      </p>
      {state.status === "error" && (
        <Notice variant="error" testId="forgot-password-error">
          {state.message}
        </Notice>
      )}
      <SubmitButton pending={pending} pendingLabel="Sending…" block>
        Send me a link
      </SubmitButton>
      <p className="mt-3 text-sm">
        <a href="/login">Back to sign in</a>
      </p>
    </form>
  );
}
