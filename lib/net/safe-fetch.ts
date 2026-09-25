import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { siteConfig } from "@/config/site.config";
import { siteUrl } from "@/lib/schema/builders";
import { slugify } from "@/lib/routing/slugify";

/**
 * Fetching a page from an address a stranger typed into a form.
 *
 * This is the one place in the codebase that fetches an attacker-chosen
 * address (the badge backlink check comes through here), which makes it server-side request forgery in its purest
 * form: without a guard, "https://my-site.example" can be swapped for
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and the
 * server cheerfully fetches the cloud instance's credentials, or for
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
 *   - the socket connects to the address the check APPROVED, not to whatever
 *     DNS says a moment later. The resolve and the connect are two lookups,
 *     and a record with a one-second TTL can answer public for the first and
 *     127.0.0.1 for the second (DNS rebinding). So the fetch goes through an
 *     undici Agent whose `lookup` answers only from a pin the guard wrote,
 *     re-pinned on every hop — see `pinnedLookup`;
 *   - at most three hops, a 10-second budget and a capped body.
 *
 * Moved here from lib/badge/backlink.ts, which re-exports the guard so its
 * callers and tests are unchanged.
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
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site local (deprecated)
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

export interface ApprovedUrl {
  url: URL;
  /**
   * Every address the host answered with, all of them public — or, for a
   * literal address, that address. What the socket is allowed to connect to.
   */
  addresses: string[];
}

/**
 * Parses `raw`, refuses anything not http(s), and refuses any host that does
 * not resolve exclusively to public addresses. Returns the URL together with
 * the addresses it approved, because approving is only half the job: the
 * socket has to be held to the same answer (`pinnedLookup`), or a record
 * with a one-second TTL can answer public here and private to the connect.
 */
export async function resolvePublicUrl(
  raw: string,
  resolve: Resolver = defaultResolver,
): Promise<ApprovedUrl> {
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
    return { url, addresses: [literal] };
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
  return { url, addresses };
}

/** `resolvePublicUrl` for callers that only want the verdict. */
export async function assertPublicUrl(
  raw: string,
  resolve: Resolver = defaultResolver,
): Promise<URL> {
  return (await resolvePublicUrl(raw, resolve)).url;
}

/**
 * A `lookup` for the connector that never asks DNS.
 *
 * `net.connect` resolves the hostname itself, through whatever `lookup` it is
 * given, and by default that is a second, independent DNS query — the one an
 * attacker answers differently. This one answers only from `pins`, which
 * `fetchPublicHtml` writes with the addresses `resolvePublicUrl` just approved
 * and rewrites on every hop. A host with no pin is refused outright rather
 * than looked up, so there is no path from "the guard did not approve this"
 * to "a socket opened anyway".
 *
 * Node calls it with `all: true` when it wants every address (happy
 * eyeballs) and without it when it wants one; both shapes are answered.
 */
export function pinnedLookup(pins: ReadonlyMap<string, readonly string[]>): LookupFunction {
  return (hostname, options, callback) => {
    const addresses = pins.get(hostname.toLowerCase()) ?? [];
    if (addresses.length === 0) {
      const err: NodeJS.ErrnoException = new Error(
        `refused: ${hostname} was not approved for this check`,
      );
      err.code = "ENOTFOUND";
      callback(err, options.all ? [] : "");
      return;
    }
    const entries = addresses.map((address) => ({ address, family: isIP(address) }));
    // Honour a family filter when it can be honoured; otherwise every pinned
    // address is fair game, and the stack picks.
    const wanted = options.family === 4 || options.family === 6 ? options.family : null;
    const filtered = wanted === null ? entries : entries.filter((e) => e.family === wanted);
    const answer = filtered.length > 0 ? filtered : entries;
    if (options.all) callback(null, answer);
    else callback(null, answer[0]!.address, answer[0]!.family);
  };
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

/**
 * The fetch every hop goes through. Global `fetch`'s signature satisfies it,
 * which is what the tests hand in; the default is undici's own, because only
 * undici's fetch accepts an undici Agent as its `dispatcher` — Node's bundled
 * copy is a different build and rejects the handler interface.
 */
export type SafeFetch = (
  url: string,
  init: RequestInit & { dispatcher: Dispatcher },
) => Promise<Response>;

const defaultFetch: SafeFetch = (url, init) =>
  // undici's Response is the same implementation Node's global one is built
  // from; the types are declared twice, not different.
  undiciFetch(url, init as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

/**
 * Names the fetcher and where to complain. Callers with a more specific
 * purpose (the backlink check) pass their own; sites block what they cannot
 * identify, and a fetcher that pretends to be Chrome deserves to be blocked.
 */
export function defaultUserAgent(): string {
  return `${slugify(siteConfig.name)}-fetch/1.0 (+${siteUrl("/trust")})`;
}

export interface SafeFetchDeps {
  resolve?: Resolver;
  fetchImpl?: SafeFetch;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  /**
   * Builds the dispatcher every hop goes through, from the pinned lookup its
   * connector must use. Tests capture the lookup here; the default is a plain
   * undici Agent, closed when the fetch ends.
   */
  agentFactory?: (lookup: LookupFunction) => Dispatcher;
}

export interface FetchedPage {
  /** The URL of the hop that answered 2xx, after any redirects. */
  finalUrl: string;
  html: string;
  status: number;
}

/**
 * Why a fetch produced no page. A refusal, a network error, a non-2xx, too
 * many redirects or an oversized body — all of them ordinary for a URL a
 * stranger typed, so they are one type carrying how far the fetch got.
 */
export class SafeFetchError extends Error {
  constructor(
    message: string,
    /** HTTP status of the last hop that answered, or null if none did. */
    readonly status: number | null,
    /** The last URL tried, or null if none was. */
    readonly finalUrl: string | null,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Fetches `url` through the SSRF guard and returns the page's HTML.
 *
 * Throws `SafeFetchError` for every way it can fail, and nothing else.
 */
export async function fetchPublicHtml(
  url: string,
  deps: SafeFetchDeps = {},
): Promise<FetchedPage> {
  const resolve = deps.resolve ?? defaultResolver;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  const userAgent = deps.userAgent ?? defaultUserAgent();

  // The pin: hostname → the addresses the guard approved for it, rewritten on
  // every hop so the connector can only ever reach what THIS hop approved.
  const pins = new Map<string, string[]>();
  const agentFactory =
    deps.agentFactory ?? ((lookup: LookupFunction) => new Agent({ connect: { lookup } }));
  const dispatcher = agentFactory(pinnedLookup(pins));

  // One budget for the whole chain, not one per hop: three hops at ten
  // seconds each is a thirty-second stall.
  const signal = AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS);

  let current = url;
  let status: number | null = null;

  try {
    for (let hop = 0; ; hop++) {
      let target: URL;
      try {
        const approved = await resolvePublicUrl(current, resolve);
        target = approved.url;
        // Re-pinned per hop, and ONLY this hop's host: the previous host's
        // pooled socket (if any) is already open to an approved address, and a
        // fresh connection to it would have to be approved afresh.
        pins.clear();
        pins.set(target.hostname.replace(/^\[|\]$/g, "").toLowerCase(), approved.addresses);
      } catch (e) {
        throw new SafeFetchError(message(e), status, current);
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
          // The socket resolves through the pin, never through DNS.
          dispatcher,
        });
      } catch (e) {
        throw new SafeFetchError(message(e), status, target.toString());
      }

      status = response.status;

      if (status >= 300 && status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (location === null || location.trim() === "") {
          throw new SafeFetchError("redirect with no location", status, target.toString());
        }
        if (hop >= maxRedirects) {
          throw new SafeFetchError(`more than ${maxRedirects} redirects`, status, target.toString());
        }
        try {
          current = new URL(location, target).toString();
        } catch {
          throw new SafeFetchError("unparseable redirect location", status, target.toString());
        }
        continue;
      }

      const finalUrl = target.toString();
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new SafeFetchError(`HTTP ${status}`, status, finalUrl);
      }

      try {
        return { finalUrl, html: await readCapped(response), status };
      } catch (e) {
        throw new SafeFetchError(message(e), status, finalUrl);
      }
    }
  } finally {
    // An Agent holds sockets; one per fetch, closed with it.
    await dispatcher.close().catch(() => {});
  }
}
