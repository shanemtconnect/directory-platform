import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";

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
 * paths stale. Absolute URLs and protocol-relative paths are rejected before
 * they reach `revalidatePath`; a bearer that leaked would cost render work,
 * not data.
 */

export const dynamic = "force-dynamic";

export const MAX_PATHS = 100;

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

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.INTERNAL_REVALIDATE_SECRET?.trim() ?? "";
  if (secret === "") return notFound();

  const token = bearerToken(request);
  if (token === null || !tokenMatches(token, secret)) return notFound();

  let body: unknown;
  try {
    body = await request.json();
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
