"use client";

import { useActionState } from "react";
import {
  requestPasswordResetAction,
  type ForgotPasswordState,
} from "@/app/forgot-password/actions";

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
      <div className="card max-w-md" data-testid="forgot-password-sent">
        <p role="status">{state.message}</p>
        <p className="text-sm">
          Nothing in your inbox after a few minutes? Check the spam folder, then{" "}
          <a href="/forgot-password">try again</a>.
        </p>
      </div>
    );
  }

  return (
    <form action={action} data-testid="forgot-password-form" className="card max-w-md">
      <p>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
      </p>
      {state.status === "error" && (
        <p role="alert" data-testid="forgot-password-error">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? "Sending…" : "Send me a link"}
      </button>
      <p className="mt-3 text-sm">
        <a href="/login">Back to sign in</a>
      </p>
    </form>
  );
}
