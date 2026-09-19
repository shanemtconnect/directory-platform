"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth/client";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const MIN_PASSWORD = 10;

/**
 * Changing a password from inside the account.
 *
 * A client call rather than a server action, unlike the profile form beside
 * it: Better Auth wants the current password and owns the hash, so going
 * through /api/auth means the attempt is counted by the shared auth budget —
 * which is what makes "guess the current password from a signed-in session"
 * as slow as guessing it from the sign-in form.
 *
 * `revokeOtherSessions` is on. Somebody changing their password on purpose
 * almost always means "and stop whoever else is signed in", and the ones who
 * merely wanted a new password lose nothing but a re-sign-in elsewhere.
 */
export function ChangePasswordForm() {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    const currentPassword = String(form.get("current") ?? "");
    const newPassword = String(form.get("next") ?? "");

    if (newPassword.length < MIN_PASSWORD) {
      return setMessage({ kind: "error", text: `Please use at least ${MIN_PASSWORD} characters.` });
    }
    if (newPassword !== String(form.get("confirm") ?? "")) {
      return setMessage({ kind: "error", text: "Those two passwords are not the same." });
    }
    if (newPassword === currentPassword) {
      return setMessage({ kind: "error", text: "That is the password you already have." });
    }

    setPending(true);
    setMessage(null);
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setPending(false);

    if (error) {
      return setMessage({
        kind: "error",
        text: "That current password isn't right. Try again, or reset it by email.",
      });
    }
    setMessage({
      kind: "ok",
      text: "Password changed. Any other devices you were signed in on are signed out within a minute.",
    });
  }

  return (
    <form action={onSubmit} data-testid="change-password-form" className="card max-w-xl">
      <p>
        <label htmlFor="cp-current">Current password</label>
        <input
          id="cp-current"
          name="current"
          type="password"
          required
          autoComplete="current-password"
        />
      </p>
      <p>
        <label htmlFor="cp-next">New password</label>
        <input
          id="cp-next"
          name="next"
          type="password"
          required
          minLength={MIN_PASSWORD}
          autoComplete="new-password"
        />
        <small>At least {MIN_PASSWORD} characters.</small>
      </p>
      <p>
        <label htmlFor="cp-confirm">Type it again</label>
        <input id="cp-confirm" name="confirm" type="password" required autoComplete="new-password" />
      </p>
      {message && (
        <Notice
          variant={message.kind === "error" ? "error" : "success"}
          testId="change-password-message"
        >
          {message.text}
        </Notice>
      )}
      <SubmitButton pending={pending} pendingLabel="Changing…">
        Change password
      </SubmitButton>
      <p className="mt-3 text-sm">
        Forgotten it? <a href="/forgot-password">Reset it by email</a> instead.
      </p>
    </form>
  );
}
