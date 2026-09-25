/**
 * Throwaway-inbox services (pay-per-lead, D11).
 *
 * A lead is sold on the promise that the person can be reached. An address at
 * one of these is reachable for ten minutes, by anyone who types the name
 * into the service's front page — so a lead from one is refused before it is
 * created, not refunded after it is bought.
 *
 * In-repo and deliberately short: the well-known services that account for
 * nearly all of it. Not a feed, not a dependency, and not a promise to catch
 * every one — the verification click and the refund policy catch the rest.
 * Add to it when a refund names a new one.
 */
export const DISPOSABLE_DOMAINS: readonly string[] = [
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "33mail.com",
  "anonbox.net", "burnermail.io", "discard.email", "discardmail.com",
  "dispostable.com", "dropmail.me", "emailondeck.com", "fakeinbox.com",
  "fakemail.net", "getairmail.com", "getnada.com", "guerrillamail.biz",
  "guerrillamail.com", "guerrillamail.de", "guerrillamail.info", "guerrillamail.net",
  "guerrillamail.org", "guerrillamailblock.com", "harakirimail.com", "inboxbear.com",
  "incognitomail.org", "jetable.org", "mail-temp.com", "mailcatch.com",
  "maildrop.cc", "mailinator.com", "mailinator.net", "mailinator2.com",
  "mailnesia.com", "mailnull.com", "mailpoof.com", "mintemail.com",
  "moakt.com", "mohmal.com", "mytemp.email", "nada.email",
  "sharklasers.com", "spam4.me", "spamgourmet.com", "spambox.us",
  "temp-mail.io", "temp-mail.org", "tempail.com", "tempinbox.com",
  "tempmail.com", "tempmail.net", "tempmailo.com", "tempr.email",
  "throwawaymail.com", "trashmail.com", "trashmail.de", "trashmail.net",
  "yopmail.com", "yopmail.fr", "yopmail.net", "grr.la",
  "mailtemp.info", "minuteinbox.com",
];

const listed = new Set(DISPOSABLE_DOMAINS);

/**
 * True when the address's domain, or any parent of it, is on the list
 * (`eu.mailinator.com` is Mailinator). Case and surrounding space ignored.
 */
export function isDisposableEmail(email: string): boolean {
  const at = email.trim().lastIndexOf("@");
  if (at < 0) return false;
  const labels = email.trim().slice(at + 1).toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (listed.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
