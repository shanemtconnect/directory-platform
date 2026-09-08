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
      <h1>Create an account</h1>
      <p>
        Free. You&rsquo;ll need one to claim a {siteConfig.entity.singular} listing
        or manage one you already own.
      </p>
      <SignupForm />
      <p>
        Already registered? <a href="/login">Sign in</a>.
      </p>
    </main>
  );
}
