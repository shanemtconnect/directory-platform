import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { countryProfile } from "@/lib/geo/countries";
import { Confirm, Draft, formatDate } from "@/components/layout/legal-blocks";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Terms of use",
  description: `The terms you agree to by using ${siteConfig.name}, and what we do and do not promise about the listings on it.`,
  alternates: { canonical: "/terms" },
};

/**
 * A TEMPLATE, not advice. Same rule as /privacy: anything a clone has to decide
 * is marked "[Confirm with counsel]" instead of being asserted. The unmarked
 * paragraphs describe how the software behaves — those are safe, because they
 * are checkable against the code rather than against a jurisdiction.
 */
export default function TermsPage() {
  const { legal, entity: e } = siteConfig;
  const profile = countryProfile(siteConfig.country);

  return (
    <main>
      <div className="prose">
        <h1>Terms of use</h1>
        <p className="text-muted">
          Last updated{" "}
          <time dateTime={legal.termsLastUpdated}>{formatDate(legal.termsLastUpdated)}</time>.
        </p>

        <p>
          These terms cover {siteConfig.domain}, operated by{" "}
          <strong>{siteConfig.legalEntity}</strong>. Using the site means accepting them.
        </p>

        <Draft>
          This is a template. Every section marked below needs to be settled before it is
          published — particularly the liability, jurisdiction and subscription clauses.
        </Draft>

        <h2>What this site is</h2>
        <p>
          {siteConfig.name} is a directory. We list {e.plural} and pass enquiries to them. We are
          not a party to anything you go on to agree with a {e.ownerNoun}, we do not take payment
          on their behalf, and we do not act as anyone&rsquo;s agent.
        </p>

        <h2>What we say about listings</h2>
        <p>
          Listing information comes from the {e.ownerNoun}, or from public sources where nobody
          has claimed the listing yet — <a href="/data-sources">where our data comes from</a>{" "}
          sets that out. We check what we reasonably can, but details change, and a listing can
          be out of date without anyone having done anything wrong. Confirm anything that
          matters with the {e.singular} directly before you rely on it.
        </p>
        <p>
          A Verified badge records that we checked identity and control on a date. It is not a
          judgement on anyone&rsquo;s work, and it is never for sale.{" "}
          <a href="/trust">What our badges do and do not mean</a>.
        </p>

        <h2>Using the site</h2>
        <ul>
          <li>Use the enquiry forms to make genuine enquiries, not to market to listed businesses.</li>
          <li>Do not scrape, bulk-copy or republish the listings.</li>
          <li>Do not attempt to interfere with the site or with anyone else&rsquo;s use of it.</li>
        </ul>

        <h2>If you list with us</h2>
        <ul>
          <li>Submit a business you own or work for, and keep its details accurate.</li>
          <li>
            Write your own description. Copy taken from another site is rejected, and if we find
            it after publication we will remove it.
          </li>
          <li>
            You keep ownership of what you upload, and you give us permission to display it on
            this site and in the ordinary places a directory listing appears.
          </li>
          <li>
            We can decline or remove a listing. We will say why rather than quietly dropping it.
          </li>
        </ul>
        <Confirm>
          The exact licence wording for submitted content, and what happens to a listing after a
          subscription ends or an account is closed.
        </Confirm>

        <h2>Paid plans</h2>
        <p>
          Paid plans buy reach and richness — never reachability. Name, address, phone number,
          opening hours, map pin, category and the enquiry form stay visible to everyone on
          every plan, including free and unclaimed listings. Prices, trial lengths and what each
          plan shows are on <a href="/pricing">the pricing page</a>, which renders from the same
          configuration the site enforces.
        </p>
        <Confirm>
          Billing terms: renewal, cancellation, refunds, the statutory cancellation period that
          applies in {profile.name}, and what a price change means for an existing subscriber.
        </Confirm>

        <h2>Reviews and reported problems</h2>
        <p>
          If something on a listing is wrong, tell us and we will look at it. Every listing
          carries a link to report incorrect information and a link to request removal,
          whatever its claim status.
        </p>
        <Confirm>
          The moderation policy and the takedown process, including how a disputed removal is
          resolved.
        </Confirm>

        <h2>Liability</h2>
        <Confirm>
          The limitation of liability, the disclaimer of warranties, and the indemnity — if any.
          Do not copy these from another site: the wording that is enforceable depends on where{" "}
          {siteConfig.legalEntity} is established and who the user is.
        </Confirm>

        <h2>Governing law</h2>
        <Confirm>
          The governing law and the courts with jurisdiction. This is the law of the place the
          site is operated from, which is not necessarily the country whose {e.plural} it lists.
        </Confirm>

        <h2>Changes to these terms</h2>
        <p>
          When these terms change the date at the top changes with them. Continuing to use the
          site after that means accepting the revised version.
        </p>

        <h2>Contact</h2>
        <p>
          <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>
        </p>

        <p className="mt-10 text-sm text-muted">
          See also our <a href="/privacy">privacy policy</a>.
        </p>
      </div>
    </main>
  );
}
