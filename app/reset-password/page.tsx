import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata: Metadata = {
  title: "Set a new password",
  robots: { index: false, follow: false },
};

/**
 * Where the link in the reset email lands.
 *
 * Not directly: the email points at `/api/auth/reset-password/<token>`, which
 * checks the token exists and has not expired and only then redirects here
 * with `?token=`. So an expired link shows the "ask for another" page below
 * rather than a form that fails after somebody has typed a password twice.
 *
 * The token is never rendered into the page's text, only into the form's
 * closure — a token in visible copy is a token in a screenshot.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = typeof raw === "string" && raw !== "" ? raw : null;

  if (token === null) {
    return (
      <main>
        <div className="mx-auto max-w-md">
          <h1>That link has expired</h1>
          <p className="text-muted" data-testid="reset-password-expired">
            Reset links work once, and for an hour. Ask for a new one and it will be
            waiting in your inbox.
          </p>
          <p>
            <a href="/forgot-password" className="btn btn-primary">
              Send me a new link
            </a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="mx-auto max-w-md">
        <h1>Set a new password</h1>
        <p className="text-muted">
          Choose something you don&rsquo;t use anywhere else. Signing in on your other
          devices will need the new one.
        </p>
        <ResetPasswordForm token={token} />
      </div>
    </main>
  );
}
