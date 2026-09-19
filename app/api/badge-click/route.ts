import { after } from "next/server";
import { db } from "@/lib/db/client";
import { badgeListing } from "@/lib/db/queries/badges";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { badgeTargetUrl } from "@/lib/badge/snippets";
import { recordBadgeClick } from "@/lib/badge/counters";
import { clientIp, rateLimitSubject } from "@/lib/spam/client-ip";
import { rateLimit } from "@/lib/spam/rate-limit";

/**
 * GET /api/badge-click?id={listingId}
 *
 * The badge's anchor points here rather than straight at the listing, so a
 * click from a third-party site is countable at all. It does one published
 * lookup, records the click in Redis and 302s on.
 *
 * A 302 and not a 301: a permanent redirect is cached by the browser for ever,
 * and the second click from that visitor would never reach us.
 */

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generous — this is a real visitor clicking a link, and a busy embed on a
 * popular site is exactly the traffic we want. It exists to stop someone
 * inflating a listing's click count (or hammering the lookup) from one host.
 */
const LIMIT = { limit: 120, windowSeconds: 60 };

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  // Checked before it reaches a uuid column, and before it costs a Redis
  // round trip: the query string is public.
  if (!UUID.test(id)) return text("Bad request", 400);

  const subject = rateLimitSubject(clientIp(request.headers));
  const limited = await rateLimit(subject === null ? null : `badge-click:${subject}`, LIMIT);
  if (!limited.allowed) {
    return text("Too many requests", 429, { "Retry-After": String(limited.retryAfterSeconds) });
  }

  const row = await badgeListing(db as never, PUBLIC_VIEWER, id);
  if (!row) return text("Not found", 404);

  // Counted after the response is on its way. A click is a vanity metric; the
  // visitor should not wait on Redis for it, and a Redis outage must not turn
  // every badge on the web into a dead link.
  after(() => {
    void recordBadgeClick(row.id).catch(() => {});
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: badgeTargetUrl(`/${row.citySlug}/${row.slug}`),
      // Never cached: a CDN holding this would count one click for ever.
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer-when-downgrade",
    },
  });
}
