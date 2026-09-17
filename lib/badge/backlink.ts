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
 *   - port 80 or 443 only, because a fetcher that will connect anywhere is a
 *     port scanner even when it never gets a page back;
 *   - the host is RESOLVED and every address it answers with must be public,
 *     because a public hostname pointing at 127.0.0.1 costs an attacker one
 *     DNS record;
 *   - every IPv6 literal is expanded to sixteen BYTES before it is judged.
 *     Text matching loses here: `[::ffff:127.0.0.1]` comes back out of
 *     `URL` as `[::ffff:7f00:1]`, so a dotted-quad pattern is checking a
 *     spelling that no longer exists;
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
 * Expands an IPv6 literal to its sixteen bytes, or null if it is not one.
 *
 * Matching IPv6 with a regex on its TEXT is the trap this exists to avoid.
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address, and WHATWG
 * `URL` re-serialises the first into the second — so a dotted-quad pattern
 * checks a spelling the URL no longer has, and loopback walks straight
 * through. Sixteen bytes have exactly one spelling.
 *
 * `node:net`'s `isIP` does the grammar; this only does the arithmetic.
 */
export function expandIpv6(raw: string): Uint8Array | null {
  // Brackets are URL syntax and a zone id (%eth0) is local to the sender —
  // neither is part of the address.
  let text = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (isIP(text) !== 6) return null;

  // A trailing dotted quad is two hex groups written the other way round.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const quad = tail.split(".").map(Number);
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
    const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tailGroups = halves.length === 1 ? [] : halves[1] === "" ? [] : halves[1]!.split(":");
  const groups =
    halves.length === 1
      ? head
      : [...head, ...Array<string>(8 - head.length - tailGroups.length).fill("0"), ...tailGroups];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const value = Number.parseInt(groups[i]!, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function dotted(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function allZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
}

/**
 * True for anything that is not a routable public IPv6 address.
 *
 * Four of these ranges carry an IPv4 address inside them, and each is a way
 * to say "127.0.0.1" or "169.254.169.254" in v6 clothing, so each hands its
 * embedded quad to the v4 table rather than being waved through:
 *
 *   ::ffff:0:0/96   IPv4-mapped, the everyday form
 *   ::/96           IPv4-compatible, deprecated but still parsed by stacks
 *   2002::/16       6to4 — the v4 address is in bytes 2..5, not at the end
 *   64:ff9b::/96    NAT64 — a well-known prefix a translator will forward
 */
function ipv6IsPrivate(bytes: Uint8Array): boolean {
  // :: (unspecified) and ::1 (loopback) before the IPv4-compatible rule,
  // which would otherwise read them as 0.0.0.0 and 0.0.0.1.
  if (allZero(bytes, 0, 16)) return true;
  if (allZero(bytes, 0, 15) && bytes[15] === 1) return true;

  if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return ipv4IsPrivate(dotted(bytes, 12)); // ::ffff:0:0/96
  }
  if (allZero(bytes, 0, 12)) return ipv4IsPrivate(dotted(bytes, 12)); // ::/96
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return ipv4IsPrivate(dotted(bytes, 2)); // 2002::/16
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    allZero(bytes, 4, 12)
  ) {
    return ipv4IsPrivate(dotted(bytes, 12)); // 64:ff9b::/96
  }

  if ((bytes[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 link local
  if (bytes[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/**
 * True for anything that is not a routable public address.
 *
 * Unknown or unparseable input returns true: the only safe default when the
 * question is "may the worker connect to this?" is no.
 */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.trim().replace(/^\[/, "").replace(/\]$/, "").split("%")[0]!;
  if (isIP(bare) === 4) return ipv4IsPrivate(bare);
  const bytes = expandIpv6(bare);
  if (bytes === null) return true;
  return ipv6IsPrivate(bytes);
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

  // Web pages live on 80 and 443. Any other port is a service, and a fetcher
  // that will connect to an arbitrary one is a port scanner with a 10-second
  // timeout: the response code and the timing tell the caller what is
  // listening even when the body is never a page. `port` is empty when the
  // scheme default applies, which URL has already normalised for us.
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    throw new SsrfRefusal(`refused port ${url.port}`);
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
