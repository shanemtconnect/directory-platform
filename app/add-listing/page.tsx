import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { submissionOptions } from "@/lib/db/queries/submissions";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { SubmitListingForm } from "@/components/submit/SubmitListingForm";

export const metadata: Metadata = {
  title: `Add your ${siteConfig.entity.singular}`,
  description: `Submit your business to ${siteConfig.name}. Free to list, no account needed, reviewed within 24 hours.`,
};

/**
 * Deliberately no login wall.
 *
 * Requiring an account before a business has any reason to trust us is the
 * single biggest killer of submission volume on a young directory. Sign-up
 * belongs after approval, when there is a listing worth logging in to manage.
 *
 * Rendered per request: the category and region selects come from the database
 * and must not be baked into a static page that then offers a category which
 * was retired last week.
 */
export const dynamic = "force-dynamic";

export default async function AddListingPage() {
  const options = await submissionOptions(db as never, PUBLIC_VIEWER);
  const e = siteConfig.entity;
  // Server-side env: the site key is public in the markup, but it is not a
  // NEXT_PUBLIC_ variable in this repo, so the page passes it down explicitly.
  const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY?.trim() || null;

  return (
    <main>
      <h1>Add your {e.singular}</h1>

      <p>
        {siteConfig.name} is a directory of {e.plural}. Fill this in and we&rsquo;ll check the
        details and publish your listing — usually within 24 hours. Listing is free and you
        don&rsquo;t need an account.
      </p>

      <h2>Before you start</h2>
      <ul>
        <li>Submit a business you own or work for, not one you have used.</li>
        <li>Write the description yourself. We reject copy lifted from another site.</li>
        <li>
          If your business is already here, you&rsquo;ll be offered the chance to claim that
          listing instead — that keeps the page it already has.
        </li>
        <li>We never set a rating or a verified badge from a form. Both have to be earned.</li>
      </ul>

      <SubmitListingForm
        categories={options.categories}
        regions={options.regions}
        turnstileSiteKey={turnstileSiteKey}
      />
    </main>
  );
}
