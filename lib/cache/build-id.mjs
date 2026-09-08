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

/** A well-formed prefix as `cacheKeyPrefix` emits it: `namespace:buildId:`. */
const VALID_PREFIX = /^([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,128}):$/;

/**
 * @param {string} currentPrefix
 * @returns {[string, string]} the namespace and build id segments.
 */
function splitPrefix(currentPrefix) {
  const m = typeof currentPrefix === "string" ? VALID_PREFIX.exec(currentPrefix) : null;
  if (m === null) {
    throw new Error(`Not a cache key prefix: ${String(currentPrefix)}`);
  }
  return [m[1], m[2]];
}

/**
 * The glob a sweep SCANs: every build's keys in this namespace, not just the
 * current one. Derived from the prefix rather than from `CACHE_NAMESPACE` so a
 * test can sweep a namespace of its own without touching `nextjs:`.
 *
 * @param {string} currentPrefix e.g. `nextjs:abc:`
 * @returns {string} e.g. `nextjs:*`
 */
export function namespaceScanPattern(currentPrefix) {
  return `${splitPrefix(currentPrefix)[0]}:*`;
}

/**
 * Should a swept key be deleted?
 *
 * True for keys of a *previous* build — another build id, or the un-namespaced
 * `nextjs:<path>` shape written before this fix. False for the running build's
 * own keys and for anything outside the namespace, so a SCAN that returns more
 * than it was asked for still cannot cost anyone else their data.
 *
 * The comparison is a literal `startsWith` including the trailing separator:
 * `nextjs:abcd:` must not be spared by a current prefix of `nextjs:abc:`.
 *
 * @param {string} key a key as redis returned it.
 * @param {string} currentPrefix the running build's prefix; throws if malformed,
 *   because judging keys against a bad prefix would sweep the running build.
 * @returns {boolean}
 */
export function isStaleNamespaceKey(key, currentPrefix) {
  const [namespace] = splitPrefix(currentPrefix);
  if (typeof key !== "string") return false;
  if (!key.startsWith(`${namespace}:`)) return false;
  return !key.startsWith(currentPrefix);
}
