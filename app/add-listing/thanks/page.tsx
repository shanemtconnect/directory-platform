import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";

export const metadata: Metadata = {
  title: "Thanks — we've got your submission",
  description: "What happens next with the listing you just submitted.",
  // A confirmation page has nothing to offer a search result and would only
  // compete with /add-listing for the same query.
  robots: { index: false, follow: true },
};

export default function AddListingThanksPage() {
  const e = siteConfig.entity;

  return (
    <main>
      <h1>Thanks — we&rsquo;ve got it</h1>

      <p data-testid="submit-thanks">
        We aim to review every submission <strong>within 24 hours</strong>. Nothing appears on
        the site until a person has checked it.
      </p>

      <h2>What happens next</h2>
      <ol>
        <li>We check the details against the business&rsquo;s own website and public records.</li>
        <li>
          If it all holds up, your {e.singular} goes live and we email you the web address.
        </li>
        <li>
          If you asked for a paid option, that email also carries a link to start the free
          trial. We take no payment now and none when we approve you — the subscription starts
          only when you approve it with PayPal, and you can cancel it there at any time.
        </li>
        <li>
          If something doesn&rsquo;t add up we&rsquo;ll email you and say what we need, rather
          than quietly dropping it.
        </li>
      </ol>

      <p>
        Told us about a town we don&rsquo;t cover yet? That&rsquo;s fine — we add the location
        as part of the review.
      </p>

      <p>
        Questions in the meantime:{" "}
        <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
      </p>

      <p>
        <a href="/">Back to {siteConfig.name}</a>
      </p>
    </main>
  );
}
