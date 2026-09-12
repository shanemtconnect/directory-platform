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
  const next = safeNext((await searchParams).next);

  return (
    <main>
      <div className="mx-auto max-w-md">
        <h1>Sign in</h1>
        <p className="text-muted">Manage your {siteConfig.entity.singular} listing.</p>
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
