import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { guardFeature } from "@/lib/features/guard";
import { QUOTE_VERIFY_TTL_HOURS } from "@/lib/quotes/verify-ttl";
import { QUOTE_STEPS } from "@/components/quotes/steps";
import { PageHeader } from "@/components/ui/PageHeader";
import { Steps } from "@/components/ui/Steps";
import { Notice } from "@/components/ui/Notice";

/**
 * Where the verification link lands (app/get-quotes/verify/route.ts sends
 * every outcome here with `?state=`). It reads nothing and writes nothing:
 * the click has already happened, and this only says what it did.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your quote request",
  robots: { index: false, follow: false },
};

interface Props {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function QuoteConfirmedPage({ searchParams }: Props) {
  guardFeature("quoteBroadcast");
  const e = siteConfig.entity;
  const raw = (await searchParams).state;
  const state = Array.isArray(raw) ? raw[0] : raw;

  if (state === "verified" || state === "already") {
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <PageHeader title={state === "verified" ? "Thanks — your request is confirmed" : "Already confirmed"} />
          <Steps steps={QUOTE_STEPS} current={2} />
          <Notice variant="success" testId="quote-confirmed">
            {state === "verified"
              ? `Your email address is confirmed and your request is on its way. Any ${e.plural} that can help will contact you directly, so keep an eye on your inbox.`
              : `You have already confirmed this request, and it has been passed on. There is nothing more to do.`}
          </Notice>
          <p><a href="/">Back to {siteConfig.name}</a></p>
        </div>
      </main>
    );
  }

  if (state === "expired") {
    return (
      <main>
        <div className="mx-auto max-w-2xl">
          <PageHeader title="That link has expired" />
          <Notice variant="status" testId="quote-expired">
            Confirmation links last {QUOTE_VERIFY_TTL_HOURS} hours, and this one is older than that.
            Nothing was sent to anyone. If you still need quotes, please send your request again.
          </Notice>
          <p><a href="/get-quotes" className="btn btn-primary">Ask for quotes again</a></p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="mx-auto max-w-2xl">
        <PageHeader title="This link cannot be used" />
        <Notice variant="error" testId="quote-unknown">
          That is not a link we recognise. Check you copied the whole link from the email, or send
          your request again.
        </Notice>
        <p><a href="/get-quotes">Ask for quotes</a></p>
      </div>
    </main>
  );
}
