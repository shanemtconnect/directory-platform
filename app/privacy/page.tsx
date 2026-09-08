import type { ReactNode } from "react";
import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { countryProfile } from "@/lib/geo/countries";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Privacy policy",
  description: `How ${siteConfig.name} collects, uses and stores personal data, and what you can ask us to do about it.`,
  alternates: { canonical: "/privacy" },
};

/**
 * A TEMPLATE, not advice.
 *
 * Everything a clone must decide is marked "[Confirm with counsel]" rather than
 * asserted. A generated privacy policy that names a lawful basis, a retention
 * period or a supervisory authority nobody chose is worse than an obviously
 * unfinished one: it reads as a promise, and it is the promise a regulator
 * reads back to you. The facts below that are NOT marked are ones this codebase
 * can actually vouch for, because they describe what the software does.
 */
export default function PrivacyPage() {
  const { legal, entity: e } = siteConfig;
  const profile = countryProfile(siteConfig.country);

  return (
    <main>
      <div className="prose">
        <h1>Privacy policy</h1>
        <p className="text-muted">
          Last updated{" "}
          <time dateTime={legal.privacyLastUpdated}>
            {formatDate(legal.privacyLastUpdated)}
          </time>
          .
        </p>

        <p>
          This policy explains what personal data {siteConfig.domain} collects, why, and what you
          can ask us to do about it.
        </p>

        <Draft>
          This is a template. Every section marked below needs to be confirmed against how this
          site is actually operated before it is published.
        </Draft>

        <h2>Who is responsible for your data</h2>
        <p>
          The data controller is <strong>{legal.dataController}</strong>, operating{" "}
          {siteConfig.name} at {siteConfig.domain}. Write to us at{" "}
          <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
        </p>
        <Confirm>
          Registered address, company number, and whether a data protection officer or a
          representative in {profile.name} has to be named.
        </Confirm>

        <h2>What we collect</h2>
        <p>We collect three kinds of thing, and nothing else:</p>
        <ul>
          <li>
            <strong>What you send us.</strong> When you use an enquiry form, your name, email
            address, any phone number you give and the message itself. When you submit a{" "}
            {e.singular}, the business details on the form plus your own name and email so we
            can tell you the outcome. When you create an account, your name, email address and a
            hashed password.
          </li>
          <li>
            <strong>What the site remembers.</strong> A cookie identifying your saved shortlist,
            and — if you sign in — a session cookie. Neither is used for advertising.
          </li>
          <li>
            <strong>What the server logs.</strong> Ordinary request logs: IP address, the page
            requested, and the time. These exist to keep the site up and to catch abuse.
          </li>
        </ul>
        <Confirm>
          Whether analytics, error reporting or any advertising or embedded third-party content
          is in use, and what each of those collects.
        </Confirm>

        <h2>What we do with it</h2>
        <ul>
          <li>An enquiry is passed to the {e.ownerNoun} you sent it to. That is its purpose.</li>
          <li>A submitted listing is reviewed by a person before anything is published.</li>
          <li>Account details identify you when you sign in and manage a listing.</li>
          <li>Logs are used to operate the site and investigate abuse.</li>
        </ul>
        <p>
          We do not sell personal data, and we do not pass an enquirer&rsquo;s details to anyone
          other than the {e.ownerNoun} they wrote to.
        </p>
        <Confirm>
          The lawful basis relied on for each purpose above, and whether any marketing email is
          sent and on what basis.
        </Confirm>

        <h2>Who else sees it</h2>
        <p>
          Data is held by the suppliers who run this site: the hosting provider, the database
          and cache, and the email service that delivers enquiry notifications.
        </p>
        <Confirm>
          The named processors, where each stores data, and whether any transfer leaves{" "}
          {profile.name} and under what safeguard.
        </Confirm>

        <h2>How long we keep it</h2>
        <Confirm>
          A retention period for each of: enquiries, listing submissions, accounts, and server
          logs. Do not publish a number until it matches what the system actually deletes.
        </Confirm>

        <h2>Your rights</h2>
        <p>
          Subject to the law that applies to you, you can ask for a copy of the personal data we
          hold about you, ask us to correct it, ask us to delete it, or object to a particular
          use. Email{" "}
          <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a> and say
          what you want. We will not charge you for it.
        </p>
        <Confirm>
          The exact rights, the response deadline, and the supervisory authority a complaint
          goes to — all of which depend on the law of the place this site is operated from, not
          the country it lists {e.plural} in.
        </Confirm>

        <h2>Listings and public information</h2>
        <p>
          A published listing is public by design: its name, address, contact details and
          description are meant to be found. Some listings were compiled from public sources
          before anyone claimed them — <a href="/data-sources">where our data comes from</a>{" "}
          explains that, and how to ask for a listing to be corrected or removed.
        </p>

        <h2>Changes</h2>
        <p>
          When this policy changes the date at the top changes with it. There is no other
          notification, so it is worth checking if you rely on it.
        </p>

        <p className="mt-10 text-sm text-muted">
          See also our <a href="/terms">terms of use</a>.
        </p>
      </div>
    </main>
  );
}

/** A clone-specific decision this repo must not make on anyone's behalf. */
function Confirm({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[var(--radius-token)] border border-dashed border-line bg-raised p-4 text-sm">
      <strong>[Confirm with counsel]</strong> {children}
    </p>
  );
}

function Draft({ children }: { children: ReactNode }) {
  return (
    <p
      role="note"
      className="rounded-[var(--radius-token)] border-l-4 border-accent bg-raised p-4 text-sm"
    >
      <strong>Draft.</strong> {children}
    </p>
  );
}

/** Long form, in the site's own locale — this is a date a reader may rely on. */
function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(siteConfig.locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
