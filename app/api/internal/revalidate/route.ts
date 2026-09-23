import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { INTERNAL_REVALIDATE_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";

/**
 * POST /api/internal/revalidate — the worker's door into the ISR cache.
 *
 * `revalidatePath` only works inside the Next process; the worker is another
 * container. When the hourly subscription sync lands a tier change, or the
 * backlink check grants or withdraws a boost, it POSTs the affected paths
 * here (`lib/revalidate/client.ts`) and this route does the invalidation.
 *
 * Guarded by `INTERNAL_REVALIDATE_SECRET`, compared in constant time. The
 * variable is optional: unset, the route does not exist — a 404 identical to
 * any other unknown path, so a scan cannot tell it is here — and the worker
 * logs once and carries on. A wrong or missing token gets the same 404, never
 * a 401 that confirms the route and invites a second guess.
 *
 * What it can do with the right token is bounded: mark up to 100 site-relative
 * paths stale, sixty times a minute per address, from a body of at most 16 KB.
 * Absolute URLs and protocol-relative paths are rejected before they reach
 * `revalidatePath`; a bearer that leaked would cost render work, not data,
 * and only so much of it.
 */

export const dynamic = "force-dynamic";

export const MAX_PATHS = 100;

/**
 * 100 paths of up to 2048 bytes would be ~200 KB, but nothing the worker
 * sends comes near that: listing paths are two short slugs. 16 KB fits any
 * real batch with room, and is small enough that buffering it for a caller
 * who has the token costs nothing worth naming.
 */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Hash both sides before comparing: `timingSafeEqual` throws on unequal
 * lengths, and a length check that returns early is itself a timing oracle
 * for the secret's length.
 */
function tokenMatches(presented: string, secret: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Site-relative only. Exactly one leading slash (so `//host` cannot be read as
 * protocol-relative and `/\host` cannot be normalised into it), no scheme, and
 * a length nothing in this site's URL space comes near.
 */
function isSitePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\")
  );
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function payloadTooLarge(): Response {
  return Response.json({ error: `body must be at most ${MAX_BODY_BYTES} bytes` }, { status: 413 });
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.INTERNAL_REVALIDATE_SECRET?.trim() ?? "";
  if (secret === "") return notFound();

  const token = bearerToken(request);
  if (token === null || !tokenMatches(token, secret)) return notFound();

  // After the bearer, never before: a 429 to a stranger would confirm the
  // route exists, which the 404 above is there to deny.
  const limit = await limitPublicWrite("internal-revalidate", request.headers, INTERNAL_REVALIDATE_RATE_LIMIT);
  if (!limit.allowed) {
    return Response.json(
      { error: "rate limited" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  // The header first, so an honest oversized request is refused before a
  // byte of it is buffered. Unlike the PayPal webhook a missing header is not
  // refused — a chunked body is legitimate here — so the bytes that actually
  // arrive are measured too, and the header is treated as the claim it is.
  const declared = request.headers.get("content-length")?.trim() ?? "";
  if (declared !== "") {
    const declaredLength = Number(declared);
    if (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES) {
      return payloadTooLarge();
    }
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return payloadTooLarge();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const paths = (body as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths)) {
    return Response.json({ error: "paths must be an array" }, { status: 400 });
  }
  if (paths.length > MAX_PATHS) {
    return Response.json({ error: `at most ${MAX_PATHS} paths per request` }, { status: 400 });
  }
  if (!paths.every(isSitePath)) {
    return Response.json({ error: "every path must be site-relative" }, { status: 400 });
  }

  for (const path of paths) revalidatePath(path);
  return Response.json({ revalidated: paths.length });
}
