/**
 * The worker's proof of life.
 *
 * The web container has `/api/health`; the worker has no port, no requests and
 * nothing to fail loudly, so a worker that has quietly stopped scheduling looks
 * exactly like a worker with no work to do. The heartbeat is the difference:
 * a line every five minutes whose ABSENCE is the alert, carrying the queue
 * depth so the same line also says whether the work is moving.
 */

export const HEARTBEAT_INTERVAL_MINUTES = 5;

/**
 * Five minutes, not one: an alert that fires on a single missed beat fires on
 * every deploy. Uptime Kuma's push monitors default to a 60-second heartbeat
 * interval, so set the monitor's interval to 330 seconds or more — one beat
 * plus a margin — or it will alarm between perfectly healthy beats.
 */
export const HEARTBEAT_CRON = `*/${HEARTBEAT_INTERVAL_MINUTES} * * * *`;

export interface HeartbeatCounts {
  /** `job_queue` rows by status, all time. */
  queue: Record<string, number>;
  /** `job_runs` rows by status inside the last heartbeat window. */
  runs: Record<string, number>;
}

/**
 * The statuses that are always printed, even at zero.
 *
 * A missing number reads as "not measured", and the whole value of this line is
 * that a reader can tell the difference between "nothing failed" and "nobody
 * looked". `job_queue`'s own CHECK constraint allows exactly these three.
 */
const QUEUE_STATUSES = ["pending", "failed", "done"] as const;
const RUN_STATUSES = ["ok", "failed"] as const;

function pairs(counts: Record<string, number>, always: readonly string[]): string {
  const keys = [...new Set([...always, ...Object.keys(counts)])];
  return keys.map((k) => `${k}=${counts[k] ?? 0}`).join(" ");
}

/**
 * One line, because it is read in `docker logs` and grepped for. Example:
 *
 *   queue pending=3 failed=0 done=912 · runs/5m ok=12 failed=0
 */
export function heartbeatMessage(counts: HeartbeatCounts): string {
  return (
    `queue ${pairs(counts.queue, QUEUE_STATUSES)}` +
    ` · runs/${HEARTBEAT_INTERVAL_MINUTES}m ${pairs(counts.runs, RUN_STATUSES)}`
  );
}

export type UptimePushResult = "sent" | "unconfigured" | "failed";

/**
 * Short. The push is fire-and-forget decoration on a log line that has already
 * been written; a monitor that is itself down must not hold the worker's tick.
 */
export const UPTIME_PUSH_TIMEOUT_MS = 5_000;

/**
 * Tell an external monitor the worker is alive.
 *
 * `UPTIME_PUSH_URL` is an Uptime Kuma *push* monitor's URL
 * (`https://uptime.example.com/api/push/<token>`) — a pull check cannot reach
 * the worker, which listens on no port. Any endpoint that 200s on a GET works
 * the same way; Kuma is just the one the README documents.
 *
 * `status=up` and `msg` are added only when the configured URL does not already
 * carry them, so an operator who has tuned the query string keeps their version.
 *
 * Never throws and never rejects. The worst outcome of a broken monitor URL is
 * that the heartbeat is not pushed — the log line is still written either way,
 * and losing a job run over a typo'd monitoring URL would be absurd.
 */
export async function pushUptime(
  message: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<UptimePushResult> {
  const raw = env.UPTIME_PUSH_URL?.trim();
  if (raw === undefined || raw === "") return "unconfigured";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "unconfigured";
  }
  if (!url.searchParams.has("status")) url.searchParams.set("status", "up");
  if (!url.searchParams.has("msg")) url.searchParams.set("msg", message);

  // An explicit AbortController rather than `AbortSignal.timeout`, so the
  // timeout is a plain `setTimeout` that a test's fake timers can drive.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPTIME_PUSH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url.toString(), { method: "GET", signal: controller.signal });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
