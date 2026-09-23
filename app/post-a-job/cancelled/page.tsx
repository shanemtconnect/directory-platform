import type { Metadata } from "next";
import { guardFeature } from "@/lib/features/guard";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Payment cancelled",
  robots: { index: false, follow: false },
};

/** Where PayPal sends a buyer who backed out. Nothing was charged and nothing is queued. */
export default function PostAJobCancelledPage() {
  guardFeature("jobBoard");
  return (
    <main data-testid="post-job-cancelled">
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Payment cancelled" />
        <EmptyState
          title="Nothing was charged"
          action={{ href: "/post-a-job", label: "Start the post again" }}
        >
          The post was not sent for review. If you meant to pay, start again and you will be taken
          back to PayPal.
        </EmptyState>
      </div>
    </main>
  );
}
