import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { siteConfig } from "@/config/site.config";
import { siteUrl } from "@/lib/schema/builders";
import { slugify } from "@/lib/routing/slugify";

/**
 * Does the page that embedded our badge actually link back to us?
 *
 * Everything here runs in the worker against a URL a stranger typed into a
 * form, which makes it the one place in this codebase that fetches an
 * attacker-chosen address. That is server-side request forgery in its purest
 * form: without a guard, "https://my-site.example" can be swapped for
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and the
 * worker cheerfully fetches the cloud instance's credentials, or for
 * `http://127.0.0.1:5432/` to port-scan the database from inside the network.
 *
 * So the rules are:
 *   - http(s) only — file:, gopher: and friends are not links;
 *   - the host is RESOLVED and every address it answers with must be public,
 *     because a public hostname pointing at 127.0.0.1 costs an attacker one
 *     DNS record;
 *   - the same check runs again on every redirect hop, since a 302 to a
 *     private address is the standard way round a check that only looks at
 *     the URL it was given;
 *   - at most three hops, a 10-second budget and a capped body.
 *
 * There is a residual DNS-rebinding window between the resolve and the
 * connect that only a pinned-address socket can close; see the note on
 * `assertPublicUrl`.
 */

export type Resolver = (hostname: string) => Promise<string[]>;

/** Refusals are their own type so a caller can tell them from a network error. */
export class SsrfRefusal extends Error {}

/** 10 s, wall clock, for the whole check. A slow site is not worth a worker slot. */
export const FETCH_TIMEOUT_MS = 10_000;

/** Three hops. Beyond that it is a redirect chain, not a page. */
export const MAX_REDIRECTS = 3;

/**
 * Bodies are read through a counter and abandoned at this size. `response.text()`
 * buffers whatever arrives, so a hostile (or merely broken) site could hand the
 * worker an endless stream and take it down with an OOM kill. A megabyte is
 * several times the largest real HTML document; the backlink is in the markup
 * or it is not there.
 */
export const MAX_BODY_BYTES = 1_000_000;

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Not parseable as IPv4 — treat as unsafe rather than guess.
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments (192.0.0/24, 192.0.2/24)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, RFC6598
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking, RFC2544
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved and 255.255.255.255
  return false;
}

/**
 * True for anything that is not a routable public address.
 *
 * Unknown or unparseable input returns true: the only safe default when the
 * question is "may the worker connect to this?" is no.
 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4IsPrivate(ip);
  if (version !== 6) return true;

  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;

  // An IPv4-mapped or -compatible address is an IPv4 address wearing a hat.
  // Missing this is how ::ffff:127.0.0.1 gets through a v6-only check.
  const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(lower);
  if (mapped) return ipv4IsPrivate(mapped[1]!);

  if (lower === "::" || lower === "::1") return true;
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
  if (/^ff/.test(lower)) return true; // multicast
  return false;
}

const defaultResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

/**
 * Parses `raw`, refuses anything not http(s), and refuses any host that does
 * not resolve exclusively to public addresses.
 *
 * The gap this cannot close on its own: DNS is resolved here and again by the
 * socket, so a record with a one-second TTL can answer public now and private
 * a moment later (DNS rebinding). Closing it properly needs a custom
 * `lookup` on the agent that pins the address this function approved — worth
 * doing if this ever runs somewhere with an instance-metadata endpoint.
 * Until then the guard raises the cost considerably without being absolute,
 * and the worker holds no cloud credentials.
 */
export async function assertPublicUrl(
  raw: string,
  resolve: Resolver = defaultResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfRefusal(`not a URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfRefusal(`refused scheme ${url.protocol}`);
  }

  // A literal address needs no DNS, and asking for one would be a free
  // outbound query on behalf of whoever submitted the URL.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0) {
    if (isPrivateAddress(literal)) throw new SsrfRefusal(`refused private address ${literal}`);
    return url;
  }

  let addresses: string[];
  try {
    addresses = await resolve(url.hostname);
  } catch (e) {
    throw new SsrfRefusal(
      `could not resolve ${url.hostname}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (addresses.length === 0) throw new SsrfRefusal(`${url.hostname} resolves to nothing`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new SsrfRefusal(`refused private address ${address} for ${url.hostname}`);
    }
  }
  return url;
}

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

/** Reads at most `MAX_BODY_BYTES`, then gives up on the rest. */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > MAX_BODY_BYTES) throw new Error("response body exceeded the size cap");
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

export interface BacklinkCheckDeps {
  resolve?: Resolver;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
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
  const resolve = deps.resolve ?? defaultResolver;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;

  // One budget for the whole chain, not one per hop: three hops at ten
  // seconds each is a thirty-second stall on one badge.
  const signal = AbortSignal.timeout(timeoutMs);
  const userAgent = backlinkUserAgent();

  let current = url;
  let status: number | null = null;

  for (let hop = 0; ; hop++) {
    let target: URL;
    try {
      target = await assertPublicUrl(current, resolve);
    } catch (e) {
      return {
        verified: false,
        status,
        finalUrl: current,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    let response: Response;
    try {
      response = await fetchImpl(target.toString(), {
        method: "GET",
        // Our own guard follows redirects, one checked hop at a time. Letting
        // fetch do it would hand an attacker a free pass to a private address.
        redirect: "manual",
        signal,
        headers: { "User-Agent": userAgent, Accept: "text/html,*/*;q=0.8" },
      });
    } catch (e) {
      return {
        verified: false,
        status,
        finalUrl: target.toString(),
        error: e instanceof Error ? e.message : String(e),
      };
    }

    status = response.status;

    if (status >= 300 && status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (location === null || location.trim() === "") {
        return { verified: false, status, finalUrl: target.toString(), error: "redirect with no location" };
      }
      if (hop >= maxRedirects) {
        return {
          verified: false,
          status,
          finalUrl: target.toString(),
          error: `more than ${maxRedirects} redirects`,
        };
      }
      try {
        current = new URL(location, target).toString();
      } catch {
        return { verified: false, status, finalUrl: target.toString(), error: "unparseable redirect location" };
      }
      continue;
    }

    const finalUrl = target.toString();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { verified: false, status, finalUrl, error: `HTTP ${status}` };
    }

    let html: string;
    try {
      html = await readCapped(response);
    } catch (e) {
      return { verified: false, status, finalUrl, error: e instanceof Error ? e.message : String(e) };
    }

    const verified = hasBacklink(html, finalUrl, targets);
    return {
      verified,
      status,
      finalUrl,
      error: verified ? null : "no link to this listing found",
    };
  }
}
