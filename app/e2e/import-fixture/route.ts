import { fixtureHtml, fixtureRouteEnabled } from "@/lib/import/e2e-fixture";

/**
 * A stand-in "business website" for e2e/import-url.spec.ts to import from.
 * Exists only under NEXT_PUBLIC_DEMO_MODE (a build-time constant, so a
 * production clone serves a 404 here) and is noindexed either way. The import
 * can only reach it while the e2e suite runs — see lib/import/e2e-fixture.ts.
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
