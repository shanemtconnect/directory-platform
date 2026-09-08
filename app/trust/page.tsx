import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Trust and safety",
  description: "What our badges mean, what they don't, and how to report a problem.",
  alternates: { canonical: "/trust" },
};

/**
 * States plainly what "Verified" does and does not mean.
 *
 * A badge whose meaning is vague is worse than no badge: consumers read it as
 * an endorsement of the work, which we are not making and do not want to make.
 * The wording here deliberately avoids "approved", "endorsed" and "guaranteed".
 */
export default function TrustPage() {
  const e = siteConfig.entity;

  return (
    <main>
      <h1>Trust and safety</h1>

      <p>
        {siteConfig.name} is a directory. We are not the {e.singular}, we do not carry out the
        work, and we are not party to any agreement you make with a business listed here.
      </p>

      <h2>What the badges mean</h2>
      <dl>
        <dt>Unverified</dt>
        <dd>
          Nobody has claimed this listing. We compiled it from public sources, so the details
          may be out of date. Treat it as a starting point.
        </dd>

        <dt>Claimed by owner</dt>
        <dd>
          Someone has proved they control the business — by responding at the business email
          address or phone number on the listing — and now maintains the details themselves.
          It is free.
        </dd>

        <dt>Verified</dt>
        <dd>
          The owner holds a paid subscription <em>and</em> has passed our checks. We confirm
          the business exists, that the person controls it, and any credentials the listing
          claims. The date of the check is shown on the listing.
        </dd>
      </dl>

      <h2>What &ldquo;Verified&rdquo; does not mean</h2>
      <p>
        It confirms identity and credentials as at the date shown. It is <strong>not</strong> a
        guarantee of the quality of anyone&rsquo;s work, and it is not a recommendation. We do
        not assess what a business provides, and we do not arbitrate disputes. Please carry out
        your own checks before committing money — references, a written quotation, insurance,
        and any licence or registration the business is required to hold.
      </p>

      <h2>Reviews</h2>
      <p>
        We never write, buy or seed reviews, and we never publish a rating for a business that
        has not received one. Where a rating appears, it comes from real customers.
      </p>

      <h2>Reporting a problem</h2>
      <p>
        Every listing carries a link to report incorrect information. For anything more serious
        — a business that has closed, a listing you believe is fraudulent, or content that
        shouldn&rsquo;t be here — email{" "}
        <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
      </p>

      <p>
        See also: <a href="/data-sources">where our listing information comes from</a>.
      </p>
    </main>
  );
}
