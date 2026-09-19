"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth/client";
import { DEFAULT_NEXT } from "@/lib/auth/next";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * `next` arrives already validated by the page (lib/auth/next.ts). It is never
 * read from `location.search` here: a client component reading the parameter
 * itself would be a second, unvalidated route to the same redirect.
 */
export function LoginForm({ next = DEFAULT_NEXT }: { next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    setPending(true);
    setError(null);
    const { error } = await signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    setPending(false);
    // Deliberately vague: distinguishing "no such account" from "wrong
    // password" tells an attacker which addresses are registered.
    if (error) return setError("That email address and password don't match.");
    router.push(next);
    router.refresh();
  }

  return (
    <form action={onSubmit} data-testid="login-form" className="card max-w-md">
      <p>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
      </p>
      <p>
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required autoComplete="current-password" />
      </p>
      {error && (
        <Notice variant="error" testId="login-error">
          {error}
        </Notice>
      )}
      <SubmitButton pending={pending} pendingLabel="Signing in…" block>
        Sign in
      </SubmitButton>
      <p className="mt-3 text-sm">
        <a href="/forgot-password" data-testid="forgot-password-link">Forgotten your password?</a>
      </p>
    </form>
  );
}
