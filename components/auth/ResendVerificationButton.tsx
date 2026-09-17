"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth/client";

/**
 * "Send it again."
 *
 * The address is a prop read from the session on the server, never typed here:
 * a field would turn this into a form that mails an arbitrary address on
 * demand. It goes through /api/auth, so the shared auth budget already covers
 * somebody leaning on the button.
 *
 * The reply is the same whatever happens, for the same reason the
 * forgot-password page's is — and because there is nothing useful a person can
 * do with "the provider said no" anyway. The one exception is a 429 from our
 * own auth budget: "wait a few minutes" says nothing about the address, and
 * it is the one thing the person CAN act on.
 */
export function ResendVerificationButton({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "throttled">("idle");

  if (state === "throttled") {
    return (
      <span role="status" data-testid="verification-throttled">
        Too many requests just now. Try again in a few minutes.
      </span>
    );
  }

  if (state === "done") {
    return (
      <span role="status" data-testid="verification-resent">
        Sent. Give it a minute, then check your spam folder.
      </span>
    );
  }

  return (
    <button
      type="button"
      className="btn btn-secondary"
      disabled={state === "sending"}
      data-testid="resend-verification"
      onClick={async () => {
        setState("sending");
        const { error } = await authClient.sendVerificationEmail({
          email,
          callbackURL: "/verify-email",
        });
        setState(error?.status === 429 ? "throttled" : "done");
      }}
    >
      {state === "sending" ? "Sending…" : "Send it again"}
    </button>
  );
}
