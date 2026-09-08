import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Where our listing information comes from",
  description: "How we compile listings, and how to correct or remove one.",
};

/**
 * Required, not optional.
 *
 * Sites launch seeded from public sources, and a sole trader's contact details
 * are personal data. Because we did not collect them from the person concerned,
 * we owe a transparency notice and a working route to correction or removal.
 * Every unclaimed listing links here.
 */
export default function DataSourcesPage() {
  const e = siteConfig.entity;

  return (
    <main>
      <h1>Where our listing information comes from</h1>

      <p>
        {siteConfig.name} lists {e.plural} from two places: business owners who add or claim
        their own listing, and publicly available sources such as company registers, trade
        association member lists, licensing registers and local authority lists.
      </p>

      <h2>What we publish</h2>
      <p>
        For a listing we compiled ourselves, we publish facts only — name, address, phone
        number, website, category and opening hours. We do not copy descriptions, photographs
        or reviews from other websites. Any summary on an unclaimed listing is generated from
        those factual details.
      </p>

      <h2>What we don&rsquo;t do</h2>
      <p>
        We never publish a rating or a review for a listing that has not received one, and a
        listing we compiled is never shown as verified. &ldquo;Verified&rdquo; means a person
        has proved they control the business and we have checked their details.
      </p>

      <h2>If a listing is wrong</h2>
      <p>
        Every listing carries a link to report incorrect information. We&rsquo;d rather fix it
        than leave it wrong, and corrections are free whether or not you have an account.
      </p>

      <h2>If you want a listing removed</h2>
      <p>
        Every unclaimed listing carries a &ldquo;Remove this listing&rdquo; link. We action
        removal requests within five working days and record the details so a later update
        cannot reinstate the listing. You do not need to give a reason.
      </p>

      <h2>Claiming a listing</h2>
      <p>
        If the business is yours, <a href="/add-listing">claiming it</a> is free and lets you
        correct anything on the page yourself.
      </p>

      <h2>Contact</h2>
      <p>
        Email <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a> for
        anything this page doesn&rsquo;t cover, including a request for a copy of the
        information we hold.
      </p>
    </main>
  );
}
