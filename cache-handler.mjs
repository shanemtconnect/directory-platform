import { createClient } from "@redis/client";
import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { CacheHandler } from "@fortedigital/nextjs-cache-handler";
import createLruHandler from "@fortedigital/nextjs-cache-handler/local-lru";
import createRedisHandler from "@fortedigital/nextjs-cache-handler/redis-strings";
import { resolveCacheKeyPrefix } from "./lib/cache/build-id.mjs";
import { sweepStaleNamespaces, sweepDelayMs } from "./lib/cache/sweep.mjs";
import { startFallbackReminder } from "./lib/cache/fallback.mjs";

/**
 * If the boot-time Redis connect below fails, this process falls back to an
 * in-process LRU cache handler for the rest of its life — there is no retry
 * and no later hot-swap back to Redis; see lib/cache/fallback.mjs for why.
 * That degrades every replica (no cross-replica cache, nothing survives a
 * restart) with only a single boot-time log line to show for it, so
 * `startFallbackReminder` re-logs the fact every five minutes for as long as
 * the fallback is in effect, as a signal that will not scroll out of a log
 * tail. The fix is always the same: get Redis reachable, then restart the
 * container.
 */

CacheHandler.onCreation(() => {
  if (global.cacheHandlerConfig) return global.cacheHandlerConfig;
  if (global.cacheHandlerConfigPromise) return global.cacheHandlerConfigPromise;

  global.cacheHandlerConfigPromise = (async () => {
    let redisClient = null;

    // Do NOT touch Redis during `next build` — this is what makes the build
    // hang forever when Redis is unreachable.
    if (PHASE_PRODUCTION_BUILD !== process.env.NEXT_PHASE) {
      try {
        redisClient = createClient({
          url: process.env.REDIS_URL,
          pingInterval: 10000,
          socket: { connectTimeout: 5000, reconnectStrategy: (n) => (n > 5 ? false : 250 * n) },
        });
        redisClient.on("error", (e) => console.warn("[cache] redis error:", e.message));
        await redisClient.connect();
        console.info("[cache] REDIS CONNECTED");
      } catch (e) {
        console.warn("[cache] redis connect failed:", e.message);
        // `disconnect()` THROWS synchronously (ClientClosedError) on a client
        // that never opened, so a trailing `.catch()` never gets attached and
        // the throw escapes this handler, rejects the onCreation promise and
        // 500s every request — the LRU fallback below never ran. Observed with
        // REDIS_URL pointed at a closed port: the whole site returned 500
        // instead of degrading to the in-process cache.
        try {
          await redisClient?.disconnect();
        } catch {
          // Nothing to clean up; the client never opened.
        }
      }
    }

    const lruCache = createLruHandler();

    if (!redisClient?.isReady) {
      console.error("[cache] FALLING BACK TO LRU (no redis)");
      startFallbackReminder();
      global.cacheHandlerConfigPromise = null;
      global.cacheHandlerConfig = { handlers: [lruCache] };
      return global.cacheHandlerConfig;
    }

    // Namespace every key by build id. Cached HTML is not portable across
    // builds: it links `/_next/static/chunks/<hash>.css` from the build that
    // rendered it, and its forms post to server-action ids the next build does
    // not know. A shared Redis is still worth having — it is shared across
    // replicas and survives a container restart of THIS build — but a deploy
    // must start cold. See docs/spikes/2026-09-07-phase-0-isr-cache-handler.md
    // and lib/cache/sweep.mjs, which sweeps the namespaces left behind.
    const keyPrefix = resolveCacheKeyPrefix();
    console.info(`[cache] key prefix: ${keyPrefix}`);

    // Sweep the namespaces previous builds left behind. The app does this for
    // itself because the runner image cannot: it is `node:24-alpine` with the
    // standalone server and nothing else — no scripts/, no bash, no redis-cli —
    // so a platform post-deployment command running scripts/purge-cache.sh in
    // that container is not a thing that can work. The script stays for a host
    // that does have a redis-cli.
    //
    // Deferred, not immediate: during a rolling deploy the previous replica is
    // still serving from its own namespace until traffic swaps, and sweeping
    // now would pull the cache out from under it. Fire-and-forget — the site
    // must serve whether or not a housekeeping DEL succeeds.
    const delay = sweepDelayMs(process.env.CACHE_SWEEP_DELAY_MS);
    const sweepTimer = setTimeout(() => {
      sweepStaleNamespaces(redisClient, keyPrefix)
        .then((n) => console.info(`[cache] swept ${n} stale keys under previous builds`))
        .catch((e) => console.warn("[cache] stale namespace sweep failed:", e.message));
    }, delay);
    // Never hold the process open for housekeeping.
    sweepTimer.unref?.();

    global.cacheHandlerConfigPromise = null;
    global.cacheHandlerConfig = {
      handlers: [createRedisHandler({ client: redisClient, keyPrefix })],
    };
    return global.cacheHandlerConfig;
  })();

  return global.cacheHandlerConfigPromise;
});

export default CacheHandler;
