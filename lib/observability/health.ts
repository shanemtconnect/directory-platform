/**
 * What `/api/health` answers, assembled from probes the caller supplies.
 *
 * The probing and the reporting are separate on purpose: an orchestrator's
 * health check is the one request that has to behave correctly while every
 * dependency is on fire, and the only way to test that is to be able to hand it
 * a database that hangs and a Redis that throws.
 */

import type { RedisState } from "@/lib/redis/client";

export type Probe = "ok" | "fail";
export type RedisProbeResult = Probe | "absent";

export interface HealthReport {
  /**
   * What the HTTP status is derived from. True iff the database answered —
   * see `healthReport` for why Redis deliberately does not count.
   */
  ok: boolean;
  db: Probe;
  /** A fresh connection to the Redis SERVER — is it reachable from here? */
  redis: RedisProbeResult;
  /**
   * The shared handle this process actually serves rate limits and counters
   * through (`lib/redis/client.ts`). Different question from `redis` above:
   * the server can be up while this handle sits in its thirty-second
   * cooldown after one refused connect, and a monitor that only saw the
   * probe would call that process healthy while it rate-limits in memory
   * and buffers every view count. Never gates `ok`, for the same reason
   * the probe does not.
   */
  redisClient: RedisState;
  /** The build id, same one the ISR cache namespaces its keys with. */
  build: string;
  uptimeSeconds: number;
}

export interface HealthProbes {
  /** Rejects when the database is unreachable. Its resolved value is ignored. */
  db: () => Promise<unknown>;
  redis: () => Promise<RedisProbeResult>;
  /** Synchronous and side-effect free: reads the handle's state, never connects. */
  redisClient: () => RedisState;
  buildId: () => string;
  uptimeSeconds: () => number;
}

/**
 * Long enough for a cold TCP connect over a container network, short enough
 * that the answer still arrives inside Docker's default 30s HEALTHCHECK
 * timeout with room to spare. A health check that hangs is worse than one that
 * says "fail": the orchestrator learns nothing and waits anyway.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

/**
 * Resolves to `fail` rather than rejecting, for any reason at all: a rejection,
 * a throw, or silence past the deadline. Nothing a dependency does may turn
 * this route into a 500 — a 500 from the health endpoint tells an orchestrator
 * the container is broken in some unknown way, when in fact we know exactly
 * which dependency is down and want to say so.
 */
async function settle<T>(
  run: () => Promise<T>,
  failure: T,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(failure), timeoutMs);
  });
  try {
    return await Promise.race([run().catch(() => failure), deadline]);
  } catch {
    return failure;
  } finally {
    // Without this the timer keeps the event loop alive for two seconds after
    // every single health check, and holds a vitest run open at the end.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Both probes run concurrently. Sequentially, a container with a dead database
 * AND a dead Redis would take two full timeouts to answer, which is longer than
 * most orchestrators wait before recording the check as a failure of its own —
 * and the body that explains which dependency died would never be read.
 *
 * `ok` follows the database alone. Redis backs the ISR cache, and
 * `cache-handler.mjs` already falls back to a per-process LRU when it is
 * unreachable: the site is slower, not broken. Failing the health check on it
 * would take every replica out of the load balancer at once and convert a
 * degradation into an outage. The field is still reported so a monitor can
 * alert on it separately.
 */
export async function healthReport(
  probes: HealthProbes,
  timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
): Promise<HealthReport> {
  const [db, redis] = await Promise.all([
    settle<Probe>(async () => {
      await probes.db();
      return "ok";
    }, "fail", timeoutMs),
    settle<RedisProbeResult>(probes.redis, "fail", timeoutMs),
  ]);

  return {
    ok: db === "ok",
    db,
    redis,
    redisClient: probes.redisClient(),
    build: probes.buildId(),
    uptimeSeconds: probes.uptimeSeconds(),
  };
}

/**
 * How long a HEALTHY report is served from the in-process memo below before
 * the next caller triggers a fresh probe.
 *
 * `/api/health` has no authentication and opens a fresh Postgres connection
 * and a fresh Redis connection on every probe (`lib/observability/redis.ts`
 * explains why the Redis client is never reused) — which makes it the
 * cheapest way for anything hitting the site repeatedly to force a
 * connection each time. Coolify's own HEALTHCHECK already polls this route
 * every 30 seconds; a second monitor, a curious script, or a hostile scanner
 * can poll far faster than that, and none of that traffic needs an answer
 * fresher than the one this process gave a moment ago.
 */
export const HEALTH_MEMO_OK_TTL_MS = 3_000;

/**
 * How long a FAILING report stays memoised — a third of the healthy TTL,
 * deliberately shorter.
 *
 * The memo exists to spare the database and Redis repeat connection load,
 * not to slow down how fast a caller sees recovery. A few seconds of
 * staleness on "everything is fine" is invisible to whoever is watching; the
 * same staleness on "still down" right after the database actually comes
 * back is the difference between an orchestrator un-draining the container
 * on its very next poll and it waiting out a memo of an outage that has
 * already ended.
 */
export const HEALTH_MEMO_FAIL_TTL_MS = 1_000;

let memo: { report: HealthReport; expiresAt: number } | undefined;

/**
 * `healthReport`, memoised — one report per process, keyed on nothing.
 *
 * This is what `/api/health` actually calls. `healthReport` itself stays
 * unmemoised so it remains a pure function of the probes it is given, which
 * is what makes it straightforward to test.
 *
 * The route's own `Cache-Control: no-store` is unaffected by this — that
 * header is a promise to the HTTP caches sitting between here and a browser.
 * This memo is a promise to nothing but this one process's next few callers,
 * and every caller still gets a fresh HTTP response; only the work behind it
 * is sometimes skipped.
 */
export async function memoizedHealthReport(
  probes: HealthProbes,
  timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
): Promise<HealthReport> {
  const now = Date.now();
  if (memo !== undefined && now < memo.expiresAt) return memo.report;

  const report = await healthReport(probes, timeoutMs);
  memo = {
    report,
    expiresAt: Date.now() + (report.ok ? HEALTH_MEMO_OK_TTL_MS : HEALTH_MEMO_FAIL_TTL_MS),
  };
  return report;
}
