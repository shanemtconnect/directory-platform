import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/SignupForm";
import { loginPath, safeNext } from "@/lib/auth/next";
import { siteConfig } from "@/config/site.config";

export const metadata: Metadata = {
  title: "Create an account",
  robots: { index: false, follow: false },
};

/** `next` is validated here and nowhere else — see app/login/page.tsx. */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams).next);

  return (
    <main>
      <div className="mx-auto max-w-md">
        <h1>Create an account</h1>
        <p className="text-muted">
          Free. You&rsquo;ll need one to claim a {siteConfig.entity.singular} listing
          or manage one you already own.
        </p>
        <SignupForm next={next} />
        <p className="mt-4 text-sm">
          Already registered?{" "}
          <a href={loginPath(next)} data-testid="login-link">
            Sign in
          </a>
          .
        </p>
      </div>
    </main>
  );
}
