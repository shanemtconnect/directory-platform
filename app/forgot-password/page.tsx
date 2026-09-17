import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main>
      <div className="mx-auto max-w-md">
        <h1>Reset your password</h1>
        <p className="text-muted">
          Give us the address you signed up with and we&rsquo;ll send you a link to set a
          new password.
        </p>
        <ForgotPasswordForm />
      </div>
    </main>
  );
}
