import { writeFileSync } from "node:fs";

/**
 * The worker's liveness signal for a container health check.
 *
 * The worker serves no HTTP, so a port check cannot tell whether it is alive,
 * and `HEALTHCHECK NONE` turned out to be worse than a bad check: Coolify sees
 * a HEALTHCHECK instruction in the Dockerfile, waits for Docker to report
 * "healthy", and a container with no check never does — every worker deploy
 * failed after three minutes with the old container left running.
 *
 * So the worker touches a file at boot and on every heartbeat, and the
 * Dockerfile's HEALTHCHECK asks whether that file is younger than the
 * heartbeat interval plus slack. A wedged event loop stops touching it and the
 * container goes unhealthy, which is the one thing a process check would miss.
 */
export const LIVENESS_FILE = process.env.WORKER_LIVENESS_FILE ?? "/tmp/worker-alive";

/** Never throws: a read-only /tmp must not take the worker down with it. */
export function markAlive(path: string = LIVENESS_FILE, now: () => Date = () => new Date()): boolean {
  try {
    writeFileSync(path, now().toISOString());
    return true;
  } catch {
    return false;
  }
}
