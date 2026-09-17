import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ownProfile } from "@/lib/db/queries/profile";
import { siteConfig } from "@/config/site.config";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";
import { ProfileSettingsForm } from "@/components/auth/ProfileSettingsForm";
import { UnverifiedEmailBanner } from "@/components/auth/UnverifiedEmailBanner";

export const metadata: Metadata = {
  title: "Account settings",
  robots: { index: false, follow: false },
};

/**
 * The three things a person can do to their own account.
 *
 * The layout at app/account/layout.tsx has already turned a signed-out visitor
 * away, so `viewer.role === "public"` here would mean the session expired
 * between the two renders. It is handled rather than asserted because a thrown
 * error on the way to a settings page is a worse answer than the sign-in form.
 *
 * `ownProfile` is what makes requirement 4 hold without a post-signup hook:
 * it creates the `profiles` row on first read, so the first visit to /account
 * or here is enough for a freshly signed-up account to have one. See
 * lib/db/queries/profile.ts.
 *
 * Deleting an account is a `mailto:` and not a button on purpose. A real
 * deletion has to decide what happens to a claimed listing, the enquiries sent
 * through it and the audit trail that says who approved it — none of which this
 * page can answer, and a button that silently did the wrong one of those would
 * be worse than a person having to ask.
 */
export default async function AccountSettingsPage() {
  const viewer = await currentViewer();
  if (viewer.role === "public") {
    return (
      <main>
        <h1>Account settings</h1>
        <p>
          Your session has expired. <a href="/login?next=/account/settings">Sign in again</a>.
        </p>
      </main>
    );
  }

  const profile = await ownProfile(db, viewer);
  const subject = encodeURIComponent(`Please delete my account (${profile.email})`);

  return (
    <main>
      <p className="text-sm">
        <a href="/account" data-testid="settings-back">
          Back to your account
        </a>
      </p>
      <h1>Account settings</h1>

      <UnverifiedEmailBanner />

      <section aria-labelledby="settings-details">
        <h2 id="settings-details">Your details</h2>
        <ProfileSettingsForm
          name={profile.name ?? ""}
          phone={profile.phone ?? ""}
          marketingOptIn={profile.marketingOptIn}
          email={profile.email}
        />
      </section>

      <section aria-labelledby="settings-password" className="mt-8">
        <h2 id="settings-password">Password</h2>
        <ChangePasswordForm />
      </section>

      <section aria-labelledby="settings-delete" className="mt-8">
        <h2 id="settings-delete">Close your account</h2>
        <div className="card max-w-xl">
          <p>
            Write to us and we will delete your account and anything only you can see.
            Tell us whether a {siteConfig.entity.singular} you claimed should stay listed
            — closing an account does not remove it by itself.
          </p>
          <p>
            <a href={`mailto:${siteConfig.supportEmail}?subject=${subject}`} data-testid="delete-account-link">
              Email {siteConfig.supportEmail}
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
