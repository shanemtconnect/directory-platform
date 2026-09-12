import { siteOrigin } from "@/lib/site-env";
import { isBotUserAgent } from "@/lib/stats/bots";
import { MAX_BEACON_EVENTS, isBeaconMetric, isUuid } from "@/lib/stats/keys";
import { recordStats, type StatEvent } from "@/lib/stats/counters";
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
 * What reaches Redis is a listing uuid, a date and a word. This endpoint reads
 * the user agent to decide whether the caller is a person and the IP to decide
 * whether to answer at all; neither is stored.
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

interface BeaconBody {
  listingId?: unknown;
  metric?: unknown;
  events?: unknown;
}

/** Both shapes: one event inline, or a page's worth under `events`. */
function readEvents(body: BeaconBody): StatEvent[] | null {
  const raw = Array.isArray(body.events)
    ? body.events
    : [{ listingId: body.listingId, metric: body.metric }];

  const events: StatEvent[] = [];
  for (const item of raw.slice(0, MAX_BEACON_EVENTS)) {
    if (typeof item !== "object" || item === null) continue;
    const { listingId, metric } = item as BeaconBody;
    // `isBeaconMetric` and not `isStatMetric`: enquiries and shortlist saves
    // are counted inside the transaction that writes the row, and must not be
    // forgeable from the internet.
    if (isUuid(listingId) && isBeaconMetric(metric)) events.push({ listingId, metric });
  }
  return events.length > 0 ? events : null;
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

  // `request.text()` rather than `request.json()`: `navigator.sendBeacon`
  // sends a Blob whose content type the browser may rewrite to text/plain, and
  // a beacon that is silently dropped over a header is a metric that reads as
  // zero for the one browser that does it.
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new Response("Payload too large", {
      status: 413,
      headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest();

  const events = readEvents(body as BeaconBody);
  if (!events) return badRequest();

  // Fire-and-forget by contract: `recordStats` never throws, and a lost count
  // is always better than a failed request.
  await recordStats(events);
  return ignored();
}

export async function GET(): Promise<Response> {
  return new Response("Method not allowed", {
    status: 405,
    headers: { ...NO_STORE, Allow: "POST", "Content-Type": "text/plain; charset=utf-8" },
  });
}
