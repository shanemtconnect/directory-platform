import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { guardFeature } from "@/lib/features/guard";

export const metadata: Metadata = {
  title: "Thanks — your review is with us",
  description: "What happens next with the review you just wrote.",
  robots: { index: false, follow: true },
};

/**
 * Where /review/verify sends someone whose review was held.
 *
 * Deliberately honest about what happened. Telling a person their review is
 * live when it is sitting in a queue is the version of this page that produces
 * an angry email a week later.
 */
export default function LeaveReviewThanksPage() {
  guardFeature("reviews");

  return (
    <main>
      <h1>Thanks — a person is reading it</h1>

      <p data-testid="review-held">
        Your email address is confirmed. This review needs a quick check by hand before it goes
        up — that happens with anything containing a link, contact details or strong language,
        whatever the rating is.
      </p>

      <p>
        We do not reject a review for being critical, and we do not edit what you wrote. If we
        cannot publish it we will email you and say why.
      </p>

      <p>
        Questions: <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
      </p>

      <p>
        <a href="/">Back to {siteConfig.name}</a>
      </p>
    </main>
  );
}
