import type { Metadata } from "next";
import { headers } from "next/headers";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { guardFeature } from "@/lib/features/guard";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { previewReviewToken, REVIEW_TOKEN_TTL_DAYS } from "@/lib/db/queries/reviews";
import { REVIEW_VERIFY_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import { ResendVerificationForm } from "@/components/reviews/ResendVerificationForm";
import { REVIEW_STEPS } from "@/components/reviews/steps";
import { PageHeader } from "@/components/ui/PageHeader";
import { Steps } from "@/components/ui/Steps";
import { Notice } from "@/components/ui/Notice";

/**
 * `/review/verify/<token>` — where the link in the email lands.
 *
 * It reads and renders. It does not publish anything.
 *
 * The previous version published the review on the GET, on the reasoning that
 * a link in an email is the only shape that works and the token is single-use.
 * The trouble is that plenty of things which are not the reviewer will happily
 * GET a URL they find in a mailbox: mail-security scanners that follow every
 * link in a message, corporate gateways that rewrite and pre-fetch them, link
 * previewers in whatever chat app the mail is forwarded into, the browser's
 * own prefetcher. Any one of them would have put a rating on a business's page
 * before a person read the email — and the line in that email promising
 * nothing would be published was not true.
 *
 * So the token buys a sentence and a button, and the POST behind the button is
 * what publishes. The token appears in exactly one place: the form's action,
 * which is the URL the visitor is already on.
 *
 * Rendered per request, and never cached: the whole page is about the state of
 * one token, which the next request may have spent.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm your review",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ token: string }>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <div className="mx-auto max-w-2xl">{children}</div>
    </main>
  );
}

export default async function VerifyReviewPage({ params }: Props) {
  guardFeature("reviews");

  // Counted before the token is looked up, in the bucket the confirm POST
  // shares: a guess loop must not be a free query per guess.
  const limit = await limitPublicWrite("review-verify", await headers(), REVIEW_VERIFY_RATE_LIMIT);
  if (!limit.allowed) {
    return (
      <Shell>
        <PageHeader title="Too many attempts" />
        <Notice variant="error" testId="review-verify-limited">
          Too many attempts from this connection. Please try again in a minute.
        </Notice>
      </Shell>
    );
  }

  const { token } = await params;
  const raw = decodeURIComponent(token);
  const preview = await previewReviewToken(db as never, PUBLIC_VIEWER, raw);

  if (preview.outcome === "unknown") {
    return (
      <Shell>
        <PageHeader title="This link cannot be used" />
        <Notice variant="error" testId="review-verify-unknown">
          That is not a link we recognise. It may have been replaced by a newer one — check for a
          more recent email from us before writing anything again.
        </Notice>
        <p>
          <a href="/" className="btn btn-primary">Back to {siteConfig.name}</a>
        </p>
      </Shell>
    );
  }

  if (preview.outcome === "expired") {
    return (
      <Shell>
        <PageHeader title="That link has expired" />
        <Steps steps={REVIEW_STEPS} current={1} />
        <Notice variant="status" testId="review-verify-expired">
          Confirmation links last {REVIEW_TOKEN_TTL_DAYS} days, and this one is older than that.
          Your review of {preview.listingName} is still here and has not been published — we can
          send you a fresh link to the same address.
        </Notice>
        <ResendVerificationForm token={raw} />
        <p className="text-sm text-muted">
          <a href={preview.listingPath}>View {preview.listingName}</a>
        </p>
      </Shell>
    );
  }

  if (preview.outcome === "already-confirmed") {
    const published = preview.status === "published";
    return (
      <Shell>
        <PageHeader
          title={published ? "Already confirmed" : "Already confirmed — a person is reading it"}
        />
        <Steps steps={REVIEW_STEPS} current={2} />
        <Notice variant="success" testId="review-verify-confirmed">
          {published
            ? `You have already confirmed this one, and your review of ${preview.listingName} is on the site.`
            : `You have already confirmed this one. Your review of ${preview.listingName} needs a quick check by hand before it goes up — that happens with anything containing a link, contact details or strong language, whatever the rating is.`}
        </Notice>
        <p>
          <a href={`${preview.listingPath}/reviews`}>
            {published ? "See it on the site" : `Reviews of ${preview.listingName}`}
          </a>
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <PageHeader
        title={`Confirm your review of ${preview.listingName}`}
        lede={`Confirming proves the email address is yours, which is the only thing standing between a review on ${siteConfig.name} and anybody who fancies writing one.`}
      />
      <Steps steps={REVIEW_STEPS} current={1} />
      <p className="text-muted text-sm">
        If you did not write this, close this page. Nothing is published unless you press Confirm.
      </p>
      {/* A plain form, so it works with no JavaScript and the token stays in
          the action URL rather than being echoed into a hidden field. */}
      <form
        method="post"
        action={`/review/verify/${encodeURIComponent(raw)}/confirm`}
        data-testid="review-confirm"
      >
        <button type="submit" className="btn btn-primary">
          Confirm my review
        </button>
      </form>
      <p className="text-sm text-muted">
        <a href={preview.listingPath}>View {preview.listingName}</a>
      </p>
    </Shell>
  );
}
