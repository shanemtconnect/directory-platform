"use server";

import { headers } from "next/headers";
import { siteConfig } from "@/config/site.config";
import { e2eFixtureApproval } from "@/lib/import/e2e-fixture";
import { extractBusiness, type ImportedBusiness } from "@/lib/import/extract";
import { fetchPublicHtml, SafeFetchError } from "@/lib/net/safe-fetch";
import { slugify } from "@/lib/routing/slugify";
import { siteUrl } from "@/lib/schema/builders";
import { isHoneypotTripped } from "@/lib/spam/turnstile";
import { IMPORT_URL_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";

export type ImportFromUrlState =
  | { status: "idle" }
  | { status: "imported"; values: ImportedBusiness }
  | { status: "error"; message: string };

/**
 * One sentence for every way a page can fail to give us anything — refused by
 * the guard, blocked, down, a login wall, or simply no metadata. The person
 * cannot act on the difference, and the form below works either way.
 */
const REFUSAL =
  "We couldn't read that page. Facebook and Google pages usually block this — fill the form in below.";

/** The longest address worth fetching; anything longer is not a home page. */
const URL_MAX = 2048;

/**
 * "Have a website? Paste the address and we'll fill in what we can."
 *
 * Fetches the page through the SSRF guard (lib/net/safe-fetch.ts), reads its
 * OpenGraph and JSON-LD, and hands the fields back to prefill the add-listing
 * form. It never submits anything: the person reviews and edits every field,
 * and the submission still goes through `submitListing` and all its checks.
 *
 * No Turnstile here, on purpose. This step writes nothing and returns only
 * what the page already publishes, so a challenge would cost real people a
 * widget load for no protection; the submission it feeds IS behind Turnstile.
 * What it can be abused for is making the server fetch pages on someone's
 * behalf, and that is what the honeypot, the per-connection rate limit
 * (IMPORT_URL_RATE_LIMIT) and the guard's public-address, three-hop, 10 s,
 * 1 MB limits are for.
 */
export async function importFromUrl(
  _prev: ImportFromUrlState,
  form: FormData,
): Promise<ImportFromUrlState> {
  // Silent "nothing found" for a bot: telling it it was caught teaches the
  // operator to leave that field alone.
  if (isHoneypotTripped(form.get("import_company_url"))) {
    return { status: "imported", values: {} };
  }

  if (!siteConfig.listing.importFromUrl) return { status: "error", message: REFUSAL };

  // Validate before spending the budget, so a typo does not cost a look-up.
  const raw = String(form.get("url") ?? "").replace(/[\r\n]+/g, "").trim();
  const url = parseWebAddress(raw);
  if (url === null) {
    return { status: "error", message: "Please paste the address of your website, like example.co.uk." };
  }

  const limit = await limitPublicWrite("import-url", await headers(), IMPORT_URL_RATE_LIMIT);
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many look-ups from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes, or fill the form in below.`,
    };
  }

  let values: ImportedBusiness;
  try {
    const page = await fetchPublicHtml(url, {
      userAgent: `${slugify(siteConfig.name)}-listing-import/1.0 (+${siteUrl("/trust")})`,
      // Undefined everywhere but the e2e suite — see lib/import/e2e-fixture.ts.
      approve: e2eFixtureApproval(),
    });
    values = extractBusiness(page.html, page.finalUrl);
  } catch (e) {
    // A SafeFetchError is the page's problem (refused, blocked, down, too big)
    // and ordinary. Anything else is ours — an extractor bug, say — and the
    // person still gets the refusal, but an operator needs to see it.
    if (!(e instanceof SafeFetchError)) console.error("[import-url] import failed:", e);
    return { status: "error", message: REFUSAL };
  }

  // The website field alone is only the address they pasted back at them.
  const { website: _website, socials: _socials, ...found } = values;
  if (Object.keys(found).length === 0) return { status: "error", message: REFUSAL };

  return { status: "imported", values };
}

/** http(s) only; a bare domain gets https://, as the submit form's website field does. */
function parseWebAddress(raw: string): string | null {
  if (raw === "" || raw.length > URL_MAX) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === "") return null;
    return url.toString();
  } catch {
    return null;
  }
}
