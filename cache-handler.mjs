import { createClient } from "@redis/client";
import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { CacheHandler } from "@fortedigital/nextjs-cache-handler";
import createLruHandler from "@fortedigital/nextjs-cache-handler/local-lru";
import createRedisHandler from "@fortedigital/nextjs-cache-handler/redis-strings";

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
        await redisClient?.disconnect().catch(() => {});
      }
    }

    const lruCache = createLruHandler();

    if (!redisClient?.isReady) {
      console.error("[cache] FALLING BACK TO LRU (no redis)");
      global.cacheHandlerConfigPromise = null;
      global.cacheHandlerConfig = { handlers: [lruCache] };
      return global.cacheHandlerConfig;
    }

    global.cacheHandlerConfigPromise = null;
    global.cacheHandlerConfig = {
      handlers: [createRedisHandler({ client: redisClient, keyPrefix: "nextjs:" })],
    };
    return global.cacheHandlerConfig;
  })();

  return global.cacheHandlerConfigPromise;
});

export default CacheHandler;
