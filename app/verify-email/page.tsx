import type { Metadata } from "next";
import { ResendVerificationButton } from "@/components/auth/ResendVerificationButton";
import { currentViewer } from "@/lib/auth/viewer";
import { ownProfile } from "@/lib/db/queries/profile";
import { db } from "@/lib/db/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Notice } from "@/components/ui/Notice";

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
 * The absence of `?error` is not, on its own, proof of anything: the page can
 * be typed, bookmarked or reached from a link. So "confirmed" is only said
 * when the `user` row agrees (`emailVerified`, read fresh, not from the
 * session cookie), or when nobody is signed in and there is no row to ask —
 * the link a signed-out person just followed is the only way they got here
 * without an error. A signed-in viewer whose address is still unverified sees
 * the resend branch instead, whatever the URL says.
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
  const confirmed = !failed && (profile === null || profile.emailVerified);

  if (confirmed) {
    return (
      <main>
        <div className="mx-auto max-w-md">
          <PageHeader title="Address confirmed" />
          <Notice variant="success" testId="verify-email-ok" title="What happens next">
            <p className="mb-0">
              Thank you — we can reach you now. There is nothing else to do. Anything you claim
              or list from here on comes with the confirmed address attached.
            </p>
          </Notice>
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
        <PageHeader title={failed ? "That link has expired" : "Not confirmed yet"} />
        <Notice variant="status" testId="verify-email-failed">
          {failed
            ? "Confirmation links work once, and for an hour. Nothing is wrong with your " +
              "account — you just need a fresh one."
            : "Your address has not been confirmed yet. Open the link in the email we sent, " +
              "or ask for a new one below."}
        </Notice>
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
