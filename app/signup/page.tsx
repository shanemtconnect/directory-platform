import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/SignupForm";
import { siteConfig } from "@/config/site.config";

export const metadata: Metadata = {
  title: "Create an account",
  robots: { index: false, follow: false },
};

export default function SignupPage() {
  return (
    <main>
      <div className="mx-auto max-w-md">
        <h1>Create an account</h1>
        <p className="text-muted">
          Free. You&rsquo;ll need one to claim a {siteConfig.entity.singular} listing
          or manage one you already own.
        </p>
        <SignupForm />
        <p className="mt-4 text-sm">
          Already registered? <a href="/login">Sign in</a>.
        </p>
      </div>
    </main>
  );
}
