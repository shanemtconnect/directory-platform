import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { REMOVAL_SLA_WORKING_DAYS } from "@/lib/trust/working-days";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Where our listing information comes from",
  description: "How we compile listings, and how to correct or remove one.",
  alternates: { canonical: "/data-sources" },
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
        Every listing carries a &ldquo;Report incorrect information&rdquo; link. It opens a
        short form that files the correction for someone to read — corrections are free,
        whether or not you have an account, and you don&rsquo;t have to leave an email address.
        We&rsquo;d rather fix a listing than leave it wrong.
      </p>

      <h2>If you want a listing removed</h2>
      <p>
        Every listing carries a &ldquo;Request removal&rdquo; link, which opens a form asking
        who you are and where to send the answer. We action removal requests within{" "}
        {REMOVAL_SLA_WORKING_DAYS} working days and email you when it is done. You do not need
        to give a reason.
      </p>
      <p>
        When we remove a listing we record enough about it — the name, the postcode and the
        contact details we held — to stop a later update from reinstating it. That record
        exists so you never have to ask twice, and it is not used for anything else.
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
