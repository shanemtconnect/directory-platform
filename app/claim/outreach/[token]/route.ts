import { db } from "@/lib/db/client";
import { recordOutreachClick } from "@/lib/db/queries/outreach";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { clientIp, rateLimitSubject } from "@/lib/spam/client-ip";
import { rateLimit } from "@/lib/spam/rate-limit";

/**
 * GET /claim/outreach/{token}
 *
 * The magic link printed in a claim-outreach message. It records that the
 * recipient opened it and forwards to the claim flow, which owns everything
 * after the redirect.
 *
 * This route is a redirect and nothing else: rendering the claim page here
 * would put a bearer token in the URL of a page with real content, which is
 * the URL that ends up in a screenshot, a support ticket and a referer header.
 */

export const dynamic = "force-dynamic";

/**
 * The token is 32 bytes of CSPRNG, so guessing it is not realistic — but a
 * limit costs nothing and keeps a brute-force attempt from also being a free
 * database query generator.
 */
const LIMIT = { limit: 30, windowSeconds: 60 };

const HEADERS = {
  // A token in a shared cache is somebody else's listing.
  "Cache-Control": "no-store, private",
  // And a token in a Referer header is the same thing with extra steps.
  "Referrer-Policy": "no-referrer",
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  const subject = rateLimitSubject(clientIp(request.headers));
  const limited = await rateLimit(subject === null ? null : `outreach-claim:${subject}`, LIMIT);
  if (!limited.allowed) {
    return new Response("Too many requests", {
      status: 429,
      headers: { ...HEADERS, "Retry-After": String(limited.retryAfterSeconds) },
    });
  }

  const hit = await recordOutreachClick(db as never, PUBLIC_VIEWER, token);
  // A wrong token and an expired campaign look identical from out here, on
  // purpose: a distinguishable response is an oracle.
  if (!hit) return new Response("Not found", { status: 404, headers: HEADERS });

  return new Response(null, {
    status: 302,
    headers: { ...HEADERS, Location: `/claim/${hit.listingId}?via=outreach` },
  });
}
