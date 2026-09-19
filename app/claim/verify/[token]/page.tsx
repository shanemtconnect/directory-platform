import type { Metadata } from "next";
import { headers } from "next/headers";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { previewClaimToken } from "@/lib/db/queries/claims";
import { CLAIM_VERIFY_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import { CLAIM_STEPS } from "@/components/claim/steps";
import { PageHeader } from "@/components/ui/PageHeader";
import { Steps } from "@/components/ui/Steps";
import { Notice } from "@/components/ui/Notice";

/**
 * `/claim/verify/<token>` — the magic link's landing page.
 *
 * It reads and renders. It does not claim anything.
 *
 * The previous version completed the claim on the GET, on the reasoning that
 * an email client cannot POST. The trouble is that plenty of things which are
 * not the recipient will happily GET: mail-security scanners that follow every
 * link in a message, corporate gateways that rewrite and pre-fetch them, link
 * previewers in chat apps the mail gets forwarded into, and the browser's own
 * prefetcher. Any one of them would have handed the listing over before a
 * person read the email — and the "if you did not ask for this, ignore it"
 * line in the message would have been a lie.
 *
 * So the token buys you a sentence and a button, and the POST behind the
 * button is what decides. The token appears in exactly one place on the page:
 * the form's action, which is the URL the visitor is already on.
 *
 * No sign-in is required to get here. The token IS the credential, and the
 * link is very often opened in a different browser from the one that started
 * the claim — the listing goes to the profile that REQUESTED it, not to
 * whoever clicked, so there is nothing for an anonymous visitor to steer.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm your claim",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ token: string }>;
}

export default async function VerifyClaimPage({ params }: Props) {
  // Counted before the token is looked up, in the bucket the confirm POST
  // shares: a guess loop must not be a free query per guess.
  const limit = await limitPublicWrite("claim-verify", await headers(), CLAIM_VERIFY_RATE_LIMIT);
  if (!limit.allowed) {
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <PageHeader title="Too many attempts" />
          <Notice variant="error" testId="claim-verify-limited">
            Too many attempts from this connection. Please try again in a minute.
          </Notice>
        </div>
      </main>
    );
  }

  const { token } = await params;
  const viewer = await currentViewer();
  const preview = await previewClaimToken(db, viewer, decodeURIComponent(token));
  const e = siteConfig.entity;

  if (preview.outcome !== "confirmable") {
    const message =
      preview.outcome === "expired"
        ? "That link has expired. Start the claim again and we will send a fresh one."
        : preview.outcome === "already-claimed"
          ? `Somebody else claimed that ${e.singular} before this link was opened.`
          : "That link is not one we recognise. It may already have been used.";
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <PageHeader title="This link cannot be used" />
          <Notice variant="error" testId="claim-verify-dead">{message}</Notice>
          <p>
            <a href="/account" className="btn btn-primary">Go to your account</a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="mx-auto max-w-2xl" data-testid="claim-confirm">
        <PageHeader
          title={`Confirm you are claiming ${preview.listingName}`}
          lede={`Confirming hands this ${e.singular} listing to the account that asked for the link. You will be able to edit the details and see every enquiry it receives.`}
        />
        <Steps steps={CLAIM_STEPS} current={2} />
        <p className="text-muted text-sm">
          If you did not ask for this, close this page. Nothing changes unless you press Confirm.
        </p>
        {/* A plain form, so it works with no JavaScript and the token stays in
            the action URL rather than being echoed into a hidden field. */}
        <form method="post" action={`/claim/verify/${encodeURIComponent(token)}/confirm`}>
          <button type="submit" className="btn btn-primary">
            Confirm the claim
          </button>
        </form>
        <p className="text-sm text-muted">
          <a href={preview.listingPath}>View {preview.listingName}</a>
        </p>
      </div>
    </main>
  );
}
