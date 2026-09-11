/**
 * What `/api/health` answers, assembled from probes the caller supplies.
 *
 * The probing and the reporting are separate on purpose: an orchestrator's
 * health check is the one request that has to behave correctly while every
 * dependency is on fire, and the only way to test that is to be able to hand it
 * a database that hangs and a Redis that throws.
 */

export type Probe = "ok" | "fail";
export type RedisProbeResult = Probe | "absent";

export interface HealthReport {
  /**
   * What the HTTP status is derived from. True iff the database answered —
   * see `healthReport` for why Redis deliberately does not count.
   */
  ok: boolean;
  db: Probe;
  redis: RedisProbeResult;
  /** The build id, same one the ISR cache namespaces its keys with. */
  build: string;
  uptimeSeconds: number;
}

export interface HealthProbes {
  /** Rejects when the database is unreachable. Its resolved value is ignored. */
  db: () => Promise<unknown>;
  redis: () => Promise<RedisProbeResult>;
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
    build: probes.buildId(),
    uptimeSeconds: probes.uptimeSeconds(),
  };
}
