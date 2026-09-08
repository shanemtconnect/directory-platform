/**
 * Which build a cache entry belongs to.
 *
 * Redis ISR keys used to be `nextjs:/<path>`, with no build id, so a deploy
 * re-served the previous build's HTML. That HTML is not portable across builds:
 * it links `/_next/static/chunks/<hash>.css` from the build that rendered it,
 * and its forms post to server-action ids the new build has never heard of.
 * Namespacing every key by build id makes a deploy start cold instead — which
 * is the correct trade, see docs/spikes/2026-09-07-phase-0-isr-cache-handler.md.
 *
 * Plain ESM with no dependencies: `cache-handler.mjs` is loaded by the Next
 * standalone server, which does not run it through a bundler or a transpiler.
 * Kept in its own module so the derivation can be tested without standing up a
 * cache handler and a Redis.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Key namespace shared by every build of this app. */
export const CACHE_NAMESPACE = "nextjs";

/** Used when there is no build output and no explicit id — `next dev`, tests. */
export const DEV_BUILD_ID = "dev";

/**
 * Build ids are nanoid-shaped. The character class matters beyond tidiness:
 * these keys are scanned with redis glob patterns by scripts/purge-cache.sh, so
 * a `*`, `?` or `[` would let one build's purge pattern match another's keys,
 * and a `:` would forge an extra namespace segment.
 */
const VALID_BUILD_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * @param {unknown} raw
 * @returns {string | null} the trimmed id, or null if it is unusable.
 */
export function normalizeBuildId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return VALID_BUILD_ID.test(trimmed) ? trimmed : null;
}

/**
 * @param {{ fileContents?: string | null, envBuildId?: string | null }} sources
 * @returns {string} a usable build id; `DEV_BUILD_ID` if nothing else is.
 */
export function selectBuildId({ fileContents, envBuildId } = {}) {
  return normalizeBuildId(fileContents) ?? normalizeBuildId(envBuildId) ?? DEV_BUILD_ID;
}

/**
 * @param {string} buildId
 * @returns {string} e.g. `nextjs:8dhlIRUNLtpabNXf4Ajbu:`
 */
export function cacheKeyPrefix(buildId) {
  const id = normalizeBuildId(buildId);
  if (id === null) throw new Error(`Refusing to key a cache on an invalid build id: ${String(buildId)}`);
  return `${CACHE_NAMESPACE}:${id}:`;
}

/**
 * Inverse of {@link cacheKeyPrefix}, for housekeeping that has to decide which
 * namespace a key found in Redis belongs to.
 *
 * @param {unknown} key
 * @returns {string | null} null for a key that is not build-namespaced at all,
 *   which includes every key written before this scheme existed.
 */
export function buildIdFromKey(key) {
  if (typeof key !== "string") return null;
  const head = `${CACHE_NAMESPACE}:`;
  if (!key.startsWith(head)) return null;
  const rest = key.slice(head.length);
  const end = rest.indexOf(":");
  if (end <= 0) return null;
  return normalizeBuildId(rest.slice(0, end));
}

/**
 * Read `.next/BUILD_ID` relative to `cwd`. The standalone server chdirs into
 * `.next/standalone`, where the build output is copied, so this is the right
 * relative path both there and in the repo.
 *
 * @param {string} cwd
 * @returns {string | null} null if it cannot be read for any reason.
 */
export function readBuildIdFile(cwd) {
  try {
    return readFileSync(join(cwd, ".next", "BUILD_ID"), "utf8");
  } catch {
    return null;
  }
}

/**
 * The one call `cache-handler.mjs` makes. Total: a cache handler that throws on
 * import takes the whole server down.
 *
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {string}
 */
export function resolveCacheKeyPrefix({ cwd = process.cwd(), env = process.env } = {}) {
  return cacheKeyPrefix(selectBuildId({
    fileContents: readBuildIdFile(cwd),
    envBuildId: env.NEXT_BUILD_ID,
  }));
}
