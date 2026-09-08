"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signUp } from "@/lib/auth/client";

const MIN_PASSWORD = 10;

export function SignupForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    const password = String(form.get("password") ?? "");
    if (password.length < MIN_PASSWORD) {
      return setError(`Please use at least ${MIN_PASSWORD} characters.`);
    }
    setPending(true);
    setError(null);
    const { error } = await signUp.email({
      email: String(form.get("email") ?? ""),
      password,
      name: String(form.get("name") ?? ""),
    });
    setPending(false);
    if (error) return setError(error.message ?? "We couldn't create that account.");
    router.push("/account");
    router.refresh();
  }

  return (
    <form action={onSubmit} data-testid="signup-form">
      <p>
        <label htmlFor="name">Your name</label>
        <input id="name" name="name" required autoComplete="name" />
      </p>
      <p>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
      </p>
      <p>
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required
          minLength={MIN_PASSWORD} autoComplete="new-password" />
        <small>At least {MIN_PASSWORD} characters.</small>
      </p>
      {error && <p role="alert" data-testid="signup-error">{error}</p>}
      <button type="submit" disabled={pending}>{pending ? "Creating…" : "Create account"}</button>
    </form>
  );
}
