import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";
import { loginPath, safeNext } from "@/lib/auth/next";
import { siteConfig } from "@/config/site.config";

// Auth pages carry no organic value and would be near-duplicates across every
// clone. Kept out of the index deliberately.
export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

/**
 * Reading `searchParams` makes this route dynamic, which is right for a page
 * whose whole job is per-visitor state. Nothing here is cached or indexed.
 *
 * The parameter is validated HERE, once, and the validated value is what the
 * form and the signup link are given — so there is no path by which an
 * attacker-supplied `next` reaches a `router.push`.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  // Where /reset-password sends somebody once their new password is saved.
  // The reset signed out every session, so the confirmation belongs on the
  // form they have to fill in next, not on a page they have already left.
  const justReset = params.reset !== undefined;

  return (
    <main>
      <div className="mx-auto max-w-md">
        <h1>Sign in</h1>
        <p className="text-muted">Manage your {siteConfig.entity.singular} listing.</p>
        {justReset && (
          <p role="status" className="card" data-testid="password-reset-done">
            Your new password is saved. Sign in with it below.
          </p>
        )}
        <LoginForm next={next} />
        <p className="mt-4 text-sm">
          No account yet?{" "}
          <a href={loginPath(next, "/signup")} data-testid="signup-link">
            Create one
          </a>
          .
        </p>
      </div>
    </main>
  );
}
