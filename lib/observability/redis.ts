import { createClient, type RedisClientType } from "@redis/client";

export type RedisProbe = "ok" | "fail" | "absent";

/** The sliver of a Redis client this probe needs, so a test can supply one. */
export interface RedisProbeClient {
  ping: () => Promise<unknown>;
  destroy: () => void;
}

/**
 * Deliberately short. This runs inside a health check that has its own deadline
 * (`HEALTH_PROBE_TIMEOUT_MS`), and the useful answer when Redis is slow to
 * accept a connection is the same as when it is down.
 */
const CONNECT_TIMEOUT_MS = 1_000;

async function openClient(url: string): Promise<RedisProbeClient> {
  const client = createClient({
    url,
    // No reconnection. A probe wants one attempt and a verdict; retrying inside
    // it would just spend the health check's whole budget on a dead server.
    socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
  }) as RedisClientType;
  // node-redis emits 'error' on a socket failure, and an unhandled 'error' on
  // an EventEmitter is a thrown exception at the top level — which would take
  // the server down instead of failing one health check.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (e) {
    // `connect()` rejecting leaves a client nobody else holds a reference to:
    // `probeRedis`'s own `finally` only destroys whatever this function
    // successfully RETURNS, and a rejected promise returns nothing. Without
    // this, the socket `createClient` opened above stays open indefinitely.
    try {
      client.destroy();
    } catch {
      // Destroying a socket that just failed to connect can itself throw —
      // the connect failure is already the answer being reported.
    }
    throw e;
  }
  return client;
}

/**
 * A fresh connection each time, closed straight after, rather than a memoised
 * client like `lib/spam/rate-limit.ts` keeps.
 *
 * The rate limiter is on the request path and reuses a connection because the
 * cost of opening one matters there. This is a health check: what it is being
 * asked is precisely "can this container open a connection to Redis right
 * now", and a cached `isReady` handle answers a question about the past. The
 * price is one connect per probe, every 30 seconds.
 *
 * `absent` is a first-class answer, not a failure. REDIS_URL is required to
 * boot (`RUNTIME_ENV`), so in a deployed container this cannot happen — but the
 * same function is read by scripts and by a local `next dev`, and reporting a
 * dependency that was never configured as "fail" would send somebody hunting a
 * fault that does not exist.
 */
export async function probeRedis(
  env: Record<string, string | undefined> = process.env,
  connect: (url: string) => Promise<RedisProbeClient> = openClient,
): Promise<RedisProbe> {
  const url = env.REDIS_URL;
  if (url === undefined || url.trim() === "") return "absent";

  let client: RedisProbeClient | undefined;
  try {
    client = await connect(url.trim());
    await client.ping();
    return "ok";
  } catch {
    return "fail";
  } finally {
    // `destroy`, not `quit`: quit waits for a graceful QUIT round trip, which
    // on the socket that just failed is another connect timeout's worth of
    // waiting for an answer that changes nothing.
    try {
      client?.destroy();
    } catch {
      // Closing an already-dead socket throws. The verdict is already decided.
    }
  }
}
