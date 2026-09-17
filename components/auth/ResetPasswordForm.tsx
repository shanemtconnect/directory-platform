"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

const MIN_PASSWORD = 10;

/**
 * Sets the new password from the link in the email.
 *
 * The token is a prop, not something this reads out of `location.search`: the
 * page has already decided whether there is a usable one, so there is exactly
 * one place that knows what a valid arrival looks like.
 *
 * This one is a client call rather than a server action, unlike the form that
 * asked for the link. `resetPassword` goes through /api/auth, which is where
 * the shared auth rate limit lives — and guessing a 24-character token is
 * precisely the thing that limit exists to make pointless.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    const password = String(form.get("password") ?? "");
    if (password.length < MIN_PASSWORD) {
      return setError(`Please use at least ${MIN_PASSWORD} characters.`);
    }
    if (password !== String(form.get("confirm") ?? "")) {
      return setError("Those two passwords are not the same.");
    }

    setPending(true);
    setError(null);
    const { error: failed } = await authClient.resetPassword({ newPassword: password, token });
    setPending(false);
    if (failed) {
      // Almost always an expired or already-used link rather than anything
      // about the password, so the message says what to do next.
      return setError(
        "That link is no longer valid. Ask for a new one and use it within the hour.",
      );
    }

    // Every other session was signed out by the reset
    // (`revokeSessionsOnPasswordReset`), so there is no session to land in —
    // signing in with the new password is the next step, and doing it proves
    // it took.
    router.push("/login?reset=1");
    router.refresh();
  }

  return (
    <form action={onSubmit} data-testid="reset-password-form" className="card max-w-md">
      <p>
        <label htmlFor="password">New password</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={MIN_PASSWORD}
          autoComplete="new-password"
        />
        <small>At least {MIN_PASSWORD} characters.</small>
      </p>
      <p>
        <label htmlFor="confirm">Type it again</label>
        <input id="confirm" name="confirm" type="password" required autoComplete="new-password" />
      </p>
      {error && (
        <p role="alert" data-testid="reset-password-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? "Saving…" : "Set my new password"}
      </button>
    </form>
  );
}
