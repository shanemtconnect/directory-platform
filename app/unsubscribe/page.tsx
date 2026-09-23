import type { Metadata } from "next";
import { headers } from "next/headers";
import { siteConfig } from "@/config/site.config";
import { verifyUnsubscribe } from "@/lib/email/unsubscribe";
import { UNSUBSCRIBE_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";

/**
 * `/unsubscribe?t=<token>` — the opt-out link's landing page.
 *
 * It reads and renders; the POST behind the button is what writes. A GET
 * that unsubscribed would let every mail-security scanner that follows links
 * opt a business out before anyone read the email. Not behind any feature
 * flag: a link already sent has to keep working whatever the site does now.
 *
 * `?done=1` is where the POST lands: a page a person can be pointed at again.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
};

interface Props {
  searchParams: Promise<{ t?: string; done?: string }>;
}

export default async function UnsubscribePage({ searchParams }: Props) {
  const limit = await limitPublicWrite("unsubscribe", await headers(), UNSUBSCRIBE_RATE_LIMIT);
  if (!limit.allowed) {
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <PageHeader title="Too many attempts" />
          <Notice variant="error" testId="unsubscribe-limited">
            Too many attempts from this connection. Please try again in a minute.
          </Notice>
        </div>
      </main>
    );
  }

  const { t, done } = await searchParams;
  if (done === "1") {
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <PageHeader title="You're unsubscribed" />
          <Notice variant="success" testId="unsubscribe-done">
            We won&rsquo;t email that address again. If you claim your {siteConfig.entity.singular}
            later, enquiries sent through its own page still reach the account you sign in with.
          </Notice>
        </div>
      </main>
    );
  }

  const claim = verifyUnsubscribe(t);
  if (claim === null) {
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <PageHeader title="This link cannot be used" />
          <Notice variant="error" testId="unsubscribe-dead">
            That link is not one we recognise. Write to{" "}
            <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a> and we will
            remove the address by hand.
          </Notice>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="mx-auto max-w-2xl" data-testid="unsubscribe-confirm">
        <PageHeader
          title="Stop these emails?"
          lede={`Press the button and ${siteConfig.name} will stop emailing ${claim.email} about quote requests and similar messages.`}
        />
        <p className="text-muted text-sm">
          Nothing changes unless you press the button. If you did not ask for this, close this page.
        </p>
        {/* A plain form, so it works with no JavaScript. The token travels in
            the body, not the URL, so it is not in the next page's referrer. */}
        <form method="post" action="/unsubscribe/confirm">
          <input type="hidden" name="t" value={t} />
          <button type="submit" className="btn btn-primary" data-testid="unsubscribe-button">
            Unsubscribe {claim.email}
          </button>
        </form>
      </div>
    </main>
  );
}
