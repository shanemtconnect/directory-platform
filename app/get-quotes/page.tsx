import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { guardFeature } from "@/lib/features/guard";
import { isEnabled } from "@/lib/features/flags";
import { QUOTE_VERIFY_TTL_HOURS } from "@/lib/quotes/verify-ttl";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { listSwitcherCities } from "@/lib/db/queries/cities";
import { listCategories } from "@/lib/db/queries/indexes";
import { QuoteRequestForm } from "@/components/quotes/QuoteRequestForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { QUOTE_STEPS } from "@/components/quotes/steps";
import { Steps } from "@/components/ui/Steps";

/**
 * One request, several quotes.
 *
 * Behind `quoteBroadcast`: a disabled flag is a real 404 and no nav entry,
 * never an empty page. Rendered per request because it carries the
 * Turnstile site key and its option lists come from the live database; it
 * is a form, not a landing page worth caching.
 */
export const dynamic = "force-dynamic";

/** Every indexable town: a `<select>` can hold more than a link list should. */
const TOWN_LIMIT = 500;

export const metadata: Metadata = {
  title: `Get quotes from ${siteConfig.entity.plural}`,
  description:
    `Describe the job once and we send it to up to ${siteConfig.quotes.maxRecipients} ` +
    `${siteConfig.entity.plural} in your town. They reply to you directly.`,
};

export default async function GetQuotesPage() {
  guardFeature("quoteBroadcast");

  const e = siteConfig.entity;
  const leadMarketplace = isEnabled("leadMarketplace");
  const [categories, towns] = await Promise.all([
    listCategories(db, PUBLIC_VIEWER),
    listSwitcherCities(db, PUBLIC_VIEWER, { limit: TOWN_LIMIT }),
  ]);
  // Server-side env: the site key is public in the markup but is not a
  // NEXT_PUBLIC_ variable in this repo, so the page passes it down explicitly.
  const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY?.trim() || null;

  return (
    <main>
      <PageHeader
        title={`Get quotes from ${e.plural} near you`}
        lede={
          `Tell us what you need once. We pass it to up to ${siteConfig.quotes.maxRecipients} ` +
          `${e.plural} in your town — listings on a paid plan and verified listings first, then claimed ones — and they reply to you directly.`
        }
      />
      <Steps steps={QUOTE_STEPS} current={0} />

      <QuoteRequestForm
        categories={categories.map((c) => ({ id: c.id, name: c.plural }))}
        towns={towns.map((t) => ({ id: t.id, name: t.name }))}
        turnstileSiteKey={turnstileSiteKey}
        leadMarketplace={leadMarketplace}
      />

      <h2>How it works</h2>
      <ul>
        <li>We email you a link to confirm the request first. Nothing is sent to anyone until you click it, and an unconfirmed request expires after {QUOTE_VERIFY_TTL_HOURS} hours.</li>
        <li>We only send your request to {e.plural} that are listed in the town you choose and have an address we can reach.</li>
        <li>You never pay for this. {e.Plural} on a paid plan see your details straight away; the rest are told a request arrived.</li>
        {leadMarketplace ? (
          <li>Your details go to those {e.plural}. If none of them is on a paid plan, one other local {e.singular} may buy your request so you still hear back. See our <a href="/privacy">privacy policy</a>.</li>
        ) : (
          <li>Your details go to those {e.plural} and nowhere else. See our <a href="/privacy">privacy policy</a>.</li>
        )}
      </ul>
    </main>
  );
}
