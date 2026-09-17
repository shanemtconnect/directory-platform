import type { Metadata } from "next";
import { ResendVerificationButton } from "@/components/auth/ResendVerificationButton";
import { currentViewer } from "@/lib/auth/viewer";
import { ownProfile } from "@/lib/db/queries/profile";
import { db } from "@/lib/db/client";

export const metadata: Metadata = {
  title: "Confirm your email address",
  robots: { index: false, follow: false },
};

/**
 * Where the confirmation link lands after Better Auth has acted on it.
 *
 * The verification itself happens at `/api/auth/verify-email`, which flips the
 * flag and then redirects here — plain on success, with `?error=CODE` when the
 * token had expired or been used. So this page reports an outcome; it never
 * performs one, and reloading it cannot change anything.
 *
 * The resend button only appears for somebody signed in, because resending
 * needs an address and the only trustworthy source of one is their session. A
 * signed-out visitor with a dead link is sent to sign in, where the banner on
 * /account will offer the same button with the address already known.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const failed = params.error !== undefined;

  const viewer = await currentViewer();
  const profile = viewer.role === "public" ? null : await ownProfile(db, viewer);

  if (!failed) {
    return (
      <main>
        <div className="mx-auto max-w-md">
          <h1>Address confirmed</h1>
          <p className="text-muted" data-testid="verify-email-ok">
            Thank you — we can reach you now. There is nothing else to do.
          </p>
          <p>
            <a href="/account" className="btn btn-primary">
              Go to your account
            </a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="mx-auto max-w-md">
        <h1>That link has expired</h1>
        <p className="text-muted" data-testid="verify-email-failed">
          Confirmation links work once, and for an hour. Nothing is wrong with your
          account — you just need a fresh one.
        </p>
        {profile === null ? (
          <p>
            <a href="/login?next=/account" className="btn btn-primary">
              Sign in to send a new one
            </a>
          </p>
        ) : (
          <p>
            <ResendVerificationButton email={profile.email} />
          </p>
        )}
      </div>
    </main>
  );
}
