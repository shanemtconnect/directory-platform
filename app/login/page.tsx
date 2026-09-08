import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";
import { siteConfig } from "@/config/site.config";

// Auth pages carry no organic value and would be near-duplicates across every
// clone. Kept out of the index deliberately.
export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main>
      <div className="mx-auto max-w-md">
        <h1>Sign in</h1>
        <p className="text-muted">Manage your {siteConfig.entity.singular} listing.</p>
        <LoginForm />
        <p className="mt-4 text-sm">
          No account yet? <a href="/signup">Create one</a>.
        </p>
      </div>
    </main>
  );
}
