/**
 * Delete the cache namespaces left behind by previous builds.
 *
 * Keys are `nextjs:<buildId>:<path>` (see build-id.mjs), so a deploy starts
 * cold and the build before it leaves a namespace nothing will ever read again.
 * Nothing in Redis expires it: the entries carry no TTL, and the new build
 * never touches the old prefix.
 *
 * The app sweeps for itself, on boot, rather than leaning on a post-deploy
 * command: the runner image is `node:24-alpine` with the standalone server and
 * nothing else — no `scripts/`, no bash, no redis-cli — so a platform "post
 * deployment command" that runs `scripts/purge-cache.sh` in that container
 * cannot work. `scripts/purge-cache.sh` remains the manual tool for a host that
 * does have a redis-cli.
 *
 * Plain ESM, no dependencies, no import of the redis package: the client is
 * passed in. `cache-handler.mjs` is loaded by the Next standalone server
 * without a bundler or a transpiler, and this is loaded from there.
 */
import { isStaleNamespaceKey, namespaceScanPattern } from "./build-id.mjs";

/**
 * Long enough that a rolling deploy has finished swapping traffic before the
 * new replica deletes anything. Until the swap, the old replica is still
 * serving from its own namespace — sweeping immediately would pull the cache
 * out from under a container that is still answering requests.
 */
export const DEFAULT_SWEEP_DELAY_MS = 60_000;

/**
 * @param {unknown} raw the value of `CACHE_SWEEP_DELAY_MS`.
 * @returns {number} a whole number of milliseconds; the default for anything
 *   that is not one, because a bad env var must not stop the sweep or schedule
 *   it at a nonsense time.
 */
export function sweepDelayMs(raw) {
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (value === "" || value === null || value === undefined) return DEFAULT_SWEEP_DELAY_MS;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return DEFAULT_SWEEP_DELAY_MS;
  return n;
}

/**
 * SCAN the namespace and DEL every key that does not belong to this build.
 *
 * SCAN, never KEYS: this runs against the same Redis that is serving the site.
 * Deletes go out in batches, and SCAN is allowed to return a key twice — DEL
 * reports how many keys it actually removed, so the count does not drift.
 *
 * @param {{ scan: Function, del: Function }} client a connected redis client.
 * @param {string} currentPrefix the running build's prefix, `nextjs:<id>:`.
 * @param {{ batchSize?: number, scanCount?: number }} [opts]
 * @returns {Promise<number>} how many keys were deleted.
 */
export async function sweepStaleNamespaces(client, currentPrefix, opts = {}) {
  const { batchSize = 256, scanCount = 500 } = opts;
  // Validates the prefix before a single key is read: a pattern guessed from a
  // malformed prefix is how a sweep eats the running build's cache.
  const pattern = namespaceScanPattern(currentPrefix);

  let cursor = "0";
  let deleted = 0;
  let batch = [];

  do {
    const reply = await client.scan(cursor, { MATCH: pattern, COUNT: scanCount });
    // node-redis v4 replied with a numeric cursor, v6 with a string.
    cursor = String(Array.isArray(reply) ? reply[0] : reply.cursor);
    const keys = Array.isArray(reply) ? reply[1] : reply.keys;
    for (const key of keys ?? []) {
      if (isStaleNamespaceKey(key, currentPrefix)) batch.push(key);
    }
    if (batch.length >= batchSize) {
      deleted += await client.del(batch);
      batch = [];
    }
  } while (cursor !== "0");

  if (batch.length > 0) deleted += await client.del(batch);
  return deleted;
}
