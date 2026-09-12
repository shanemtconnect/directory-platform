import { getDb } from "@/lib/db/client";
import { pingDatabase } from "@/lib/db/queries/health";
import { probeRedis } from "@/lib/observability/redis";
import { memoizedHealthReport } from "@/lib/observability/health";
import { currentBuildId } from "@/lib/observability/build-id";

/**
 * The container's liveness check. Used by the Dockerfile `HEALTHCHECK`, by
 * Coolify's health check (set the path to `/api/health`), and by whatever
 * external monitor watches the site from outside.
 *
 * `force-dynamic` and `revalidate = 0` together are what keep this out of the
 * ISR cache handler. Without them Next is entitled to treat a GET route with no
 * dynamic inputs as static, and a health check served from `cache-handler.mjs`
 * is a health check of Redis: it would keep answering 200 out of the cache
 * after the database behind it had gone, which is the precise failure this
 * endpoint exists to catch. (It would also mean the health check could not
 * report on the cache without going through it.)
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * No authentication, deliberately. A health check that needs a credential is
 * one an orchestrator cannot make, and the body is four pieces of information
 * an attacker gains nothing from: two up/down booleans, the build id — already
 * visible in every `/_next/static/` URL the site serves — and a process uptime.
 * No version numbers, no hostnames, no configuration.
 *
 * Being unauthenticated is also why `memoizedHealthReport` (see
 * `lib/observability/health.ts`) sits in front of the probes: this is the one
 * route on the site anybody, including a scanner with no reason to be polite,
 * can hit as fast as they like. `Cache-Control: no-store` below is unaffected
 * — every request still gets a fresh HTTP response — only the database and
 * Redis connection behind it is sometimes skipped.
 */
export async function GET(): Promise<Response> {
  const report = await memoizedHealthReport({
    // `getDb()` inside the probe, not at module scope: this module is evaluated
    // during `next build` to read the two exports above, and opening a pool
    // there would put a database back in the build's requirements.
    db: () => pingDatabase(getDb()),
    redis: () => probeRedis(),
    buildId: currentBuildId,
    uptimeSeconds: () => Math.floor(process.uptime()),
  });

  return Response.json(report, {
    // 503, not 500: "I am here and I cannot serve" is what makes an
    // orchestrator restart or drain this container rather than record an
    // unexplained error. Retry-After keeps a polite monitor from hammering a
    // database that is already struggling.
    status: report.ok ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
      ...(report.ok ? {} : { "Retry-After": "5" }),
    },
  });
}
