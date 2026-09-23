import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { Notice } from "@/components/ui/Notice";

/** PayPal's cancel_url for a featured subscription or revision: nothing was charged. */

export const metadata: Metadata = {
  title: "Featured spots",
  robots: { index: false, follow: false },
};

export default function FeaturedCancelledPage() {
  return (
    <main data-testid="featured-cancelled">
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Nothing was changed" />
        <Notice variant="status">
          You left PayPal before approving, so no bid was placed or changed and nothing was charged.
          An unapproved bid is dropped after a day.
        </Notice>
        <p>
          <a href="/account" className="btn btn-primary">Your account</a>
        </p>
      </div>
    </main>
  );
}
