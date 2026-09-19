import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { RESET_STEPS } from "@/components/auth/steps";
import { PageHeader } from "@/components/ui/PageHeader";
import { Steps } from "@/components/ui/Steps";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main>
      <div className="mx-auto max-w-md">
        <PageHeader
          title="Reset your password"
          back={{ href: "/login", label: "Back to sign in" }}
          lede={
            <>
              Give us the address you signed up with and we&rsquo;ll send you a link to set a
              new password.
            </>
          }
        />
        <Steps steps={RESET_STEPS} current={0} />
        <ForgotPasswordForm />
      </div>
    </main>
  );
}
