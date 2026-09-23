import { siteOrigin } from "@/lib/site-env";
import { isBotUserAgent } from "@/lib/stats/bots";
import {
  MAX_BEACON_EVENTS,
  MAX_BEACON_IMPRESSIONS,
  MAX_BEACON_VIEWS,
  isBeaconMetric,
  isUuid,
} from "@/lib/stats/keys";
import { claimDailyView, recordStats, type StatEvent } from "@/lib/stats/counters";
import { MAX_BEACON_SPONSOR_IMPRESSIONS, SPONSOR_BEACON_METRIC } from "@/lib/ads/keys";
import { recordSponsorImpressions } from "@/lib/ads/counters";
import {
  FEATURED_CLICK_METRIC, MAX_BEACON_FEATURED_CLICKS, recordFeaturedClicks, type FeaturedClickEvent,
} from "@/lib/spots/clicks";
import { clientIp } from "@/lib/spam/client-ip";
import { BEACON_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";

/**
 * POST /api/beacon — the only way a view is counted.
 *
 * A listing page is ISR-cached. Counting a view on the server would count
 * cache MISSES: one render is one number no matter how many people are served
 * the stored HTML afterwards, and a popular listing would read as less
 * visited than an unpopular one. So the count comes from the browser, from a
 * one-line inline script (`components/stats/StatsBeacon.tsx`) — no library, no
 * third-party analytics, no cookie, nothing that identifies anybody.
 *
 * What reaches the counters is a listing uuid, a date and a word. This
 * endpoint reads the user agent to decide whether the caller is a person and
 * the IP to decide whether to answer at all and whether this address has
 * already been counted as a view of this listing today. That last check is
 * the one place an address is used as a key, and it is hashed first: the
 * `stats:seen:` mark carries `sha256(ip, day, salt)`, expires in a day, is
 * never read back and never joined to anything (`lib/stats/keys.ts`). Nothing
 * in Redis is an address.
 *
 * Never touches the database. That is the whole point of the design — a view
 * costs one INCR, and the worker turns five minutes of them into one row.
 */

export const dynamic = "force-dynamic";

/** A legitimate beacon of 100 events is around 6 KB. */
const MAX_BODY_BYTES = 16_384;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * 204 for everything that is not a client error, including the cases we
 * deliberately ignore.
 *
 * A crawler told it was blocked is a crawler that retries with a different
 * user agent; one given a 204 has nothing to react to. The page has nothing to
 * do with the answer either way — `sendBeacon` cannot read it.
 */
function ignored(): Response {
  return new Response(null, { status: 204, headers: NO_STORE });
}

function badRequest(): Response {
  return new Response("Bad request", {
    status: 400,
    headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function payloadTooLarge(): Response {
  return new Response("Payload too large", {
    status: 413,
    headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
  });
}

interface BeaconBody {
  listingId?: unknown;
  metric?: unknown;
  events?: unknown;
  /** Featured clicks (Task 45) name the spot the card was in. */
  spotId?: unknown;
}

/**
 * Both shapes: one event inline, or a page's worth under `events`.
 *
 * What one beacon may say is bounded here, not by the client: a (listing,
 * metric) pair counts once however many times the body repeats it, one page is
 * one view so only the first view survives, and impressions stop at a page of
 * cards. Everything past those lines is dropped without comment. The only
 * client that overshoots honestly is our own script, and a 400 would cost it
 * the whole page's counts rather than the tail; a forged batch gets nothing
 * to react to either way.
 */
interface ReadEvents {
  listings: StatEvent[];
  /** Sponsor campaign ids that were shown (Task 43); the script sends them as `listingId`. */
  sponsors: string[];
  /** Clicks on featured cards (Task 45): the spot and the listing. */
  featuredClicks: FeaturedClickEvent[];
}

function readEvents(body: BeaconBody): ReadEvents | null {
  const raw = Array.isArray(body.events)
    ? body.events
    : [{ listingId: body.listingId, metric: body.metric, spotId: body.spotId }];

  const events: StatEvent[] = [];
  const sponsors: string[] = [];
  const featuredClicks: FeaturedClickEvent[] = [];
  const seen = new Set<string>();
  let views = 0;
  let impressions = 0;
  for (const item of raw.slice(0, MAX_BEACON_EVENTS)) {
    if (typeof item !== "object" || item === null) continue;
    const { listingId: rawId, metric, spotId: rawSpot } = item as BeaconBody;
    if (metric === FEATURED_CLICK_METRIC) {
      // One (spot, listing) pair per beacon, three at most: a page has three
      // featured cards, and a click is on one of them.
      if (!isUuid(rawId) || !isUuid(rawSpot) || featuredClicks.length >= MAX_BEACON_FEATURED_CLICKS) continue;
      const click = { spotId: rawSpot.toLowerCase(), listingId: rawId.toLowerCase() };
      if (!featuredClicks.some((c) => c.spotId === click.spotId && c.listingId === click.listingId)) {
        featuredClicks.push(click);
      }
      continue;
    }
    if (metric === SPONSOR_BEACON_METRIC) {
      if (!isUuid(rawId) || sponsors.length >= MAX_BEACON_SPONSOR_IMPRESSIONS) continue;
      const campaignId = rawId.toLowerCase();
      if (!sponsors.includes(campaignId)) sponsors.push(campaignId);
      continue;
    }
    // `isBeaconMetric` and not `isStatMetric`: enquiries and shortlist saves
    // are counted inside the transaction that writes the row, and must not be
    // forgeable from the internet.
    if (!isUuid(rawId) || !isBeaconMetric(metric)) continue;
    // Lower-cased so the same uuid in two spellings is one key in Redis and
    // one entry here.
    const listingId = rawId.toLowerCase();
    const key = `${listingId}|${metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (metric === "view") {
      if (views >= MAX_BEACON_VIEWS) continue;
      views += 1;
    } else {
      if (impressions >= MAX_BEACON_IMPRESSIONS) continue;
      impressions += 1;
    }
    events.push({ listingId, metric });
  }
  return events.length > 0 || sponsors.length > 0 || featuredClicks.length > 0
    ? { listings: events, sponsors, featuredClicks }
    : null;
}

export async function POST(request: Request): Promise<Response> {
  // Free, and it discards most of the traffic a directory gets — so it runs
  // before anything that costs a Redis round trip.
  if (isBotUserAgent(request.headers.get("user-agent"))) return ignored();

  // The page that sends this is ours. A POST carrying somebody else's origin
  // is an embed inflating a listing's numbers, not a visitor. An absent Origin
  // is allowed through: not every browser sends one on a `sendBeacon`.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== siteOrigin()) return ignored();

  const limit = await limitPublicWrite("beacon", request.headers, BEACON_RATE_LIMIT);
  if (!limit.allowed) {
    return new Response("Too many requests", {
      status: 429,
      headers: {
        ...NO_STORE,
        "Retry-After": String(limit.retryAfterSeconds),
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  // Checked before touching the body: a declared size over the limit is
  // rejected without reading a byte of it, so an oversized POST costs this
  // endpoint a header lookup rather than buffering the whole thing.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return payloadTooLarge();
  }

  // `request.text()` rather than `request.json()`: `navigator.sendBeacon`
  // sends a Blob whose content type the browser may rewrite to text/plain, and
  // a beacon that is silently dropped over a header is a metric that reads as
  // zero for the one browser that does it.
  const raw = await request.text();
  // Byte length, not `raw.length`: a beacon carrying multi-byte characters
  // (an owner's listing name echoed back, say) is longer in UTF-8 than in
  // UTF-16 code units, and a Content-Length header a proxy stripped or a
  // caller lied about must not be the only thing standing between this
  // endpoint and an oversized body.
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return payloadTooLarge();
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest();

  const read = readEvents(body as BeaconBody);
  if (!read) return badRequest();
  const events = read.listings;

  // One address is one view of one listing per day. A reload is not a second
  // visitor, and neither is a script posting the same beacon in a loop — the
  // rate limit above bounds how often it may ask, this bounds what asking is
  // worth. Skipped when the address is unknown: with nothing to key a mark
  // under, counting is the honest default, and a shared bucket for every
  // unidentified visitor would let one person's view cancel everybody else's.
  const ip = clientIp(request.headers);
  const view = events.find((e) => e.metric === "view");
  const counted =
    view !== undefined && ip !== null && !(await claimDailyView(ip, view.listingId))
      ? events.filter((e) => e !== view)
      : events;

  // Fire-and-forget by contract: `recordStats` never throws, and a lost count
  // is always better than a failed request.
  if (counted.length > 0) await recordStats(counted);
  if (read.sponsors.length > 0) await recordSponsorImpressions(read.sponsors);
  if (read.featuredClicks.length > 0) await recordFeaturedClicks(read.featuredClicks);
  return ignored();
}

export async function GET(): Promise<Response> {
  return new Response("Method not allowed", {
    status: 405,
    headers: { ...NO_STORE, Allow: "POST", "Content-Type": "text/plain; charset=utf-8" },
  });
}
