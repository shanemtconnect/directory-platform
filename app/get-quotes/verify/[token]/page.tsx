import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { guardFeature } from "@/lib/features/guard";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { previewQuoteToken } from "@/lib/db/queries/quotes";
import { QUOTE_VERIFY_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import { QUOTE_STEPS } from "@/components/quotes/steps";
import { PageHeader } from "@/components/ui/PageHeader";
import { Steps } from "@/components/ui/Steps";
import { Notice } from "@/components/ui/Notice";

/**
 * `/get-quotes/verify/<token>` — where the link in the requester's email
 * lands (Task 56).
 *
 * It reads and renders; it confirms nothing. Mail scanners and link
 * previewers GET every link in a message, so the link buys a sentence and a
 * button, and the POST behind the button (`…/confirm`) is what sends the
 * request anywhere — the reviews module's pattern. A link that is already
 * used, expired or unknown goes straight to the page that says so.
 *
 * Rendered per request and never cached: it is about the state of one token.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm your request",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ token: string }>;
}

export default async function VerifyQuotePage({ params }: Props) {
  guardFeature("quoteBroadcast");

  // One bucket with the confirm POST: a guess loop against either is one loop.
  const limit = await limitPublicWrite("quote-verify", await headers(), QUOTE_VERIFY_RATE_LIMIT);
  if (!limit.allowed) {
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <PageHeader title="Too many attempts" />
          <Notice variant="error" testId="quote-verify-limited">
            Too many attempts from this connection. Please try again in a minute.
          </Notice>
        </div>
      </main>
    );
  }

  const { token } = await params;
  const raw = decodeURIComponent(token);
  const preview = await previewQuoteToken(db as never, PUBLIC_VIEWER, raw);

  switch (preview.outcome) {
    case "already-verified":
      redirect("/get-quotes/confirmed?state=already");
    case "expired":
      redirect("/get-quotes/confirmed?state=expired");
    case "unknown":
      redirect("/get-quotes/confirmed?state=unknown");
    case "live":
      break;
  }

  const what = preview.source === "enquiry" ? "enquiry" : "request";
  return (
    <main>
      <div className="mx-auto max-w-2xl">
        <PageHeader
          title={`Confirm your ${what}`}
          lede="Confirming proves this email address is yours. Nothing is sent to anyone until you do."
        />
        <Steps steps={QUOTE_STEPS} current={1} />
        <p className="text-muted text-sm">
          If you did not ask for this, close this page. Nothing is sent unless you press Confirm.
        </p>
        {/* A plain form, so it works with no JavaScript; the token stays in
            the action URL rather than being echoed into a hidden field. */}
        <form
          method="post"
          action={`/get-quotes/verify/${encodeURIComponent(raw)}/confirm`}
          data-testid="quote-verify-confirm"
        >
          <button type="submit" className="btn btn-primary">
            Confirm my {what}
          </button>
        </form>
      </div>
    </main>
  );
}
