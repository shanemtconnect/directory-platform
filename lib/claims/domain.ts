/**
 * The automatic rung of the evidence ladder.
 *
 * A claimant who can receive mail at the domain the listing already advertises
 * has proved as much as a support agent could ever establish by eye, and can be
 * approved in under a minute with nobody in the loop. Everything in this file
 * exists to make that inference safe, because the cost of getting it wrong is
 * handing a stranger control of somebody else's business listing.
 *
 * Two rules do the work. A free mailbox provider is never evidence of anything
 * — anyone can hold jo@gmail.com, including when the listing's own "website"
 * field has been filled in with a Gmail address. And a domain comparison is on
 * LABEL boundaries, never a string suffix: `notexample.com` ends with
 * `example.com` and is a completely different company.
 */

/**
 * Providers whose addresses anybody can register. Not exhaustive and never can
 * be — it is one half of a belt-and-braces pair, the other being that a
 * document claim always exists as the manual route when this rung says no.
 */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.ie",
  "ymail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "outlook.ie",
  "live.com",
  "live.co.uk",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "mail.com",
  "gmx.com",
  "gmx.net",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "yandex.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
]);

/** Lowercased, trailing dot removed, leading `www.` removed. */
function normalise(host: string): string {
  const lower = host.trim().toLowerCase().replace(/\.$/, "");
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/**
 * The registrable-ish domain of a listing's `website` column.
 *
 * The column is free text typed by whoever imported or submitted the listing,
 * so it arrives as `example.com`, `https://www.example.com/contact`, and
 * occasionally as something that is not a URL at all.
 */
export function domainOfWebsite(website: string | null | undefined): string | null {
  const raw = (website ?? "").trim();
  if (raw === "") return null;

  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    // No scheme. Try the one we would have assumed anyway — but only after the
    // parse above has had its chance, so `javascript:` is rejected on its
    // protocol rather than smuggled through as a hostname.
    try {
      url = new URL(`https://${raw}`);
    } catch {
      return null;
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = normalise(url.hostname);
  // A single label is a machine name on somebody's LAN, not a public domain.
  if (!host.includes(".")) return null;
  return host;
}

export function domainOfEmail(email: string | null | undefined): string | null {
  const raw = (email ?? "").trim();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return null;
  const host = normalise(raw.slice(at + 1));
  if (!host.includes(".")) return null;
  return host;
}

/** True for the domain itself or for anything hosted under one. */
export function isFreeMailDomain(domain: string): boolean {
  const host = normalise(domain);
  if (FREE_MAIL_DOMAINS.has(host)) return true;
  // `mail.gmail.com` is as free as `gmail.com`.
  return [...FREE_MAIL_DOMAINS].some((free) => host.endsWith(`.${free}`));
}

/**
 * Whether an address is on the listing's own domain.
 *
 * One direction only. A mailbox UNDER the listing's domain counts — a business
 * at example.com may run its mail from mail.example.com — but a mailbox at the
 * PARENT of the listing's domain does not. That second direction reads as
 * ownership only if you assume every subdomain belongs to whoever holds the
 * apex, and on shared hosting it does not: `jane.wixsite.com` and
 * `sites.google.com/view/...` are tenants, and anyone with a mailbox at the
 * platform's apex would be handed every tenant's listing.
 *
 * The cost is a business whose site is at bookings.example.com and whose mail
 * is at example.com. That is the document rung's job, and a manual review is a
 * far smaller price than a takeover.
 */
export function matchesListingDomain(
  website: string | null | undefined,
  email: string | null | undefined,
): boolean {
  const site = domainOfWebsite(website);
  const mail = domainOfEmail(email);
  if (site === null || mail === null) return false;
  if (isFreeMailDomain(site) || isFreeMailDomain(mail)) return false;
  if (site === mail) return true;
  return mail.endsWith(`.${site}`);
}
