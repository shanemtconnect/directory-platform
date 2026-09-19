/**
 * The visible, repeating signal that `cache-handler.mjs` is stuck serving the
 * in-process LRU handler instead of Redis.
 *
 * `cache-handler.mjs` logs `[cache] FALLING BACK TO LRU (no redis)` once, at
 * boot, when the initial Redis connect fails — and then never mentions it
 * again. That single line scrolls out of a container's log tail within
 * minutes, so a fallback that started during a bad deploy and outlives it can
 * run for days with nothing pointing at it: every replica keeps serving
 * (degraded — no cross-replica cache, nothing survives a restart) and nothing
 * signals that Redis needs attention. `startFallbackReminder` re-logs the
 * same fact on a timer for as long as the process runs in fallback mode, so a
 * log scrape or an on-call human tailing the container will see it again
 * within one interval, not only in whatever line scrolled by at boot.
 *
 * Deliberately does NOT attempt to hot-swap back to the Redis handler if
 * Redis becomes reachable later — `CacheHandler.onCreation` runs once per
 * process, the LRU handler is already wired into every route, and swapping
 * cache backends under live traffic is a correctness risk (stale reads,
 * torn revalidations) this file has no way to reason about safely. The fix
 * for a container stuck in fallback is what the log line says: restart it
 * once Redis is reachable again.
 *
 * Plain ESM, no dependencies — loaded by the Next standalone server the same
 * way `cache-handler.mjs` itself is, without a bundler or transpiler.
 */

/** Five minutes: often enough that a scrolling log tail cannot miss it, rare
 * enough that it never competes with real traffic logs for attention. */
export const FALLBACK_REMINDER_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Starts the repeating reminder. Returns the interval handle so a caller
 * (chiefly the test suite) can `clearInterval` it; `cache-handler.mjs` itself
 * never needs to, because the timer is `unref()`'d and must not hold the
 * process open on its own.
 *
 * @param {number} [intervalMs] defaults to `FALLBACK_REMINDER_INTERVAL_MS`.
 * @returns {ReturnType<typeof setInterval>}
 */
export function startFallbackReminder(intervalMs = FALLBACK_REMINDER_INTERVAL_MS) {
  const timer = setInterval(() => {
    console.error(
      "[cache] STILL FALLING BACK TO LRU (no redis) — restart this container once Redis is reachable",
    );
  }, intervalMs);
  // Never hold the process open just to keep reminding.
  timer.unref?.();
  return timer;
}
