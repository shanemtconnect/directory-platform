import { fixtureHtml, fixtureRouteEnabled } from "@/lib/import/e2e-fixture";

/**
 * A stand-in "business website" for e2e/import-url.spec.ts to import from.
 * Serves only while NEXT_PUBLIC_DEMO_MODE is the literal "true" — read from
 * the server's environment on each request (bracket access, as
 * lib/blog/demo.ts does), so a server without it answers 404 — and is
 * noindexed either way. The import can reach it only while the e2e suite's
 * dedicated switch is on — see lib/import/e2e-fixture.ts.
 */
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
  if (!fixtureRouteEnabled()) {
    return new Response("Not found", { status: 404, headers: { ...headers, "Content-Type": "text/plain" } });
  }
  return new Response(fixtureHtml(new URL(request.url).searchParams), {
    status: 200,
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}
