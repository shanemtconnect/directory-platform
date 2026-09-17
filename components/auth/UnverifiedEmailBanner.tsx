import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ownProfile } from "@/lib/db/queries/profile";
import { ResendVerificationButton } from "./ResendVerificationButton";

/**
 * "We haven't confirmed this address yet."
 *
 * A component with no props rather than a block inside /account, because
 * app/account/page.tsx is owned by another task: mounting `<UnverifiedEmailBanner />`
 * anywhere inside /account is the whole integration, and it renders nothing at
 * all for a verified or signed-out viewer, so there is no condition for the
 * host page to get wrong.
 *
 * Deliberately a notice and not a gate. `requireEmailVerification` is false
 * (lib/auth/server.ts) and claims have their own proof of ownership, so an
 * unverified person can still sign in, still claim and still be answered. What
 * is actually at stake is that we may not be able to reach them, which is what
 * this says — an unverified address is our problem to explain, not a
 * punishment to administer.
 *
 * It also guarantees requirement 4 as a side effect: `ownProfile` creates the
 * profile row if signing up has not yet caused one, so simply opening /account
 * is enough for a fresh account to have one.
 */
export async function UnverifiedEmailBanner() {
  const viewer = await currentViewer();
  if (viewer.role === "public") return null;

  const profile = await ownProfile(db, viewer);
  if (profile.emailVerified) return null;

  return (
    <aside
      className="card"
      role="status"
      data-testid="unverified-email-banner"
      aria-label="Email address not confirmed"
    >
      <p>
        <strong>Confirm your email address.</strong> We sent a link to{" "}
        <span data-testid="unverified-email-address">{profile.email}</span> when you
        signed up. Until you use it we can&rsquo;t be sure we can reach you about
        anything you list or claim.
      </p>
      <p className="text-sm text-muted">
        You can carry on in the meantime — nothing here depends on it.
      </p>
      <ResendVerificationButton email={profile.email} />
    </aside>
  );
}
