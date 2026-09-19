/**
 * The worker's way of telling the web container a cached page is stale.
 *
 * `revalidatePath` only works inside the Next process that owns the cache,
 * and the worker is a different container running plain Node. So a tier
 * change landed by the hourly subscription sync, or a backlink boost granted
 * or withdrawn by the weekly check, is POSTed here to
 * `/api/internal/revalidate` on the web container, which does the actual
 * invalidation. Without this the listing page and the city pillar keep
 * serving the old tier — description length, website gating, featured row,
 * sort order — until the ISR window turns over.
 *
 * The secret is shared with the route and optional: a site that has not set
 * `INTERNAL_REVALIDATE_SECRET` gets the pre-existing behaviour (pages catch
 * up on their own schedule) and one log line saying why, not a failed job.
 *
 * Call this AFTER the transaction that made the change has committed. The
 * route marks the path stale and the next request re-renders it; a request
 * that lands between "marked stale" and "committed" would re-cache the old
 * row for another full ISR window, which is the very thing this exists to
 * stop. `worker/index.ts` therefore runs it once `withAdvisoryLock` has
 * returned, on the paths the job handed back, rather than the job calling it
 * from inside the lock's transaction.
 *
 * Never throws and never rejects. Losing a job run — and the writes it made —
 * over a cache nudge that failed would be strictly worse than a stale page.
 */

/** The route's cap. Longer lists are sent in several requests. */
export const MAX_PATHS_PER_REQUEST = 100;

export const REVALIDATE_ROUTE = "/api/internal/revalidate";

/** Bounded so a wedged web container cannot hold the worker's connection open. */
const TIMEOUT_MS = 10_000;

export interface RevalidateDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface RevalidateResult {
  /** Paths the web container accepted. */
  readonly sent: number;
  /** True when the secret is unset and nothing was attempted. */
  readonly skipped: boolean;
}

let warnedUnset = false;

export async function revalidatePaths(
  paths: readonly string[],
  deps: RevalidateDeps = {},
): Promise<RevalidateResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((line: string) => console.warn(`[worker] ${line}`));

  const unique = [...new Set(paths)];
  if (unique.length === 0) return { sent: 0, skipped: false };

  const secret = env.INTERNAL_REVALIDATE_SECRET?.trim() ?? "";
  if (secret === "") {
    if (!warnedUnset) {
      warnedUnset = true;
      log(
        "INTERNAL_REVALIDATE_SECRET is unset — tier and backlink changes made by the worker " +
          "will show on cached pages only when the ISR window turns over",
      );
    }
    return { sent: 0, skipped: true };
  }

  const origin = (env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
  if (origin === "") {
    log("NEXT_PUBLIC_SITE_URL is unset — cannot reach the revalidate route");
    return { sent: 0, skipped: false };
  }
  const url = `${origin}${REVALIDATE_ROUTE}`;

  let sent = 0;
  for (let i = 0; i < unique.length; i += MAX_PATHS_PER_REQUEST) {
    const batch = unique.slice(i, i + MAX_PATHS_PER_REQUEST);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ paths: batch }),
        signal: controller.signal,
      });
      if (res.ok) {
        sent += batch.length;
      } else {
        log(`revalidate: ${url} answered ${res.status} for ${batch.length} path(s)`);
      }
    } catch (e) {
      log(`revalidate: ${url} unreachable — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { sent, skipped: false };
}
