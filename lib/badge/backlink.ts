import type { Dispatcher } from "undici";
import type { LookupFunction } from "node:net";
import { siteConfig } from "@/config/site.config";
import { siteUrl } from "@/lib/schema/builders";
import { slugify } from "@/lib/routing/slugify";
import {
  fetchPublicHtml,
  SafeFetchError,
  type Resolver,
  type SafeFetch,
} from "@/lib/net/safe-fetch";

/**
 * Does the page that embedded our badge actually link back to us?
 *
 * The URL is one a stranger typed into a form, so the page is fetched through
 * `fetchPublicHtml` (lib/net/safe-fetch.ts), which holds the SSRF guard: public
 * addresses only, pinned DNS, three hops, a 10-second budget and a capped
 * body. The guard's pieces are re-exported here because this is where they
 * were born and where the worker and the tests already import them from.
 */
export {
  assertPublicUrl,
  expandIpv6,
  FETCH_TIMEOUT_MS,
  isPrivateAddress,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  pinnedLookup,
  resolvePublicUrl,
  SsrfRefusal,
  type ApprovedUrl,
  type Resolver,
} from "@/lib/net/safe-fetch";

/** The fetch the check goes through — see `SafeFetch`. */
export type BacklinkFetch = SafeFetch;

/**
 * Comparison key for "is this the same page?".
 *
 * Scheme, `www.`, query, fragment and a trailing slash are all noise here —
 * the badge snippet itself appends `?utm_source=badge`, and a site that links
 * to the http:// form of us has still linked to us.
 */
function linkKey(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  return `${host}${path === "" ? "/" : path}`;
}

/** `<a ...>` open tags. Deliberately not `<img>` or `<script>`: only links count. */
const ANCHOR = /<a\b[^>]*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Is there an `<a href>` in `html` pointing at one of `targets`?
 *
 * A string search for the URL would be wrong in both directions: it counts the
 * badge IMAGE's `src` (which is on our domain and appears on every single
 * embed, so every embed would verify without one real link) and it counts the
 * URL printed as plain text. Only an anchor is a backlink.
 *
 * `rel` is deliberately NOT inspected, so a `rel="nofollow"` anchor COUNTS.
 * The badge asks an owner to display a mark and link it to their listing, and
 * they have done exactly that; whether their CMS, their security policy or
 * their own judgement adds nofollow is not something they always control and
 * is not what the +5 is for. Rewarding only dofollow links would also make
 * this a paid-link scheme in all but name — we would be handing out ranking
 * in exchange for a specific link attribute, which is the thing search
 * engines penalise. And we offer a nofollow variant of the snippet ourselves
 * (see `badgeTrackedSnippetHtml`); refusing to count what we hand out would
 * be indefensible.
 */
export function hasBacklink(html: string, pageUrl: string, targets: string[]): boolean {
  const wanted = new Set<string>();
  for (const target of targets) {
    try {
      wanted.add(linkKey(new URL(target)));
    } catch {
      // A target we cannot parse is a caller bug, not a page failure.
    }
  }
  if (wanted.size === 0) return false;

  for (const tag of html.matchAll(ANCHOR)) {
    const attr = HREF.exec(tag[0]);
    if (!attr) continue;
    const href = (attr[1] ?? attr[2] ?? attr[3] ?? "").trim();
    if (href === "") continue;
    try {
      // Relative and protocol-relative hrefs resolve against the page they
      // were found on, which is what a browser would do.
      if (wanted.has(linkKey(new URL(href, pageUrl)))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Names the crawler, its purpose and where to complain. Sites block what they
 * cannot identify, and a directory that verifies backlinks by pretending to be
 * Chrome deserves to be blocked.
 */
export function backlinkUserAgent(): string {
  return `${slugify(siteConfig.name)}-backlink-check/1.0 (+${siteUrl("/trust")})`;
}

export interface BacklinkCheckDeps {
  resolve?: Resolver;
  fetchImpl?: BacklinkFetch;
  timeoutMs?: number;
  maxRedirects?: number;
  /**
   * Builds the dispatcher every fetch in this check goes through, from the
   * pinned lookup its connector must use. Tests capture the lookup here; the
   * default is a plain undici Agent, closed when the check ends.
   */
  agentFactory?: (lookup: LookupFunction) => Dispatcher;
}

export interface BacklinkCheckResult {
  verified: boolean;
  /** HTTP status of the final hop, or null if nothing was ever fetched. */
  status: number | null;
  finalUrl: string | null;
  /** Why it did not verify. Null on success. */
  error: string | null;
}

/**
 * Fetches `url` and reports whether it links to any of `targets`.
 *
 * Never throws: a badge check failing is ordinary (sites go down, snippets get
 * deleted), and a throw here would abort a batch of a hundred other badges.
 */
export async function checkBacklink(
  url: string,
  targets: string[],
  deps: BacklinkCheckDeps = {},
): Promise<BacklinkCheckResult> {
  try {
    const page = await fetchPublicHtml(url, { ...deps, userAgent: backlinkUserAgent() });
    const verified = hasBacklink(page.html, page.finalUrl, targets);
    return {
      verified,
      status: page.status,
      finalUrl: page.finalUrl,
      error: verified ? null : "no link to this listing found",
    };
  } catch (e) {
    if (e instanceof SafeFetchError) {
      return { verified: false, status: e.status, finalUrl: e.finalUrl, error: e.message };
    }
    return { verified: false, status: null, finalUrl: url, error: e instanceof Error ? e.message : String(e) };
  }
}
