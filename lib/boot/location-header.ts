import { ServerResponse } from "node:http";

type AppendHeader = ServerResponse["appendHeader"];

/**
 * Wraps `ServerResponse.prototype.appendHeader` so that appending a `Location`
 * value the response already carries is a no-op.
 *
 * WHY THIS EXISTS — a defect in Next.js 16.3.4, not in this repo.
 *
 * On a COLD ISR response (`x-nextjs-cache: MISS`) every redirect served by the
 * `app/[...segments]` catch-all arrived with `Location` emitted TWICE, same
 * value both times. Warm responses (`HIT`) emitted it once. Traced with a
 * prototype-level trace hook, the two writes are:
 *
 *   1. During the render, `next/dist/server/app-render/app-render.js` handles
 *      the redirect error with `setHeader('location', redirectUrl)` — a wrapper
 *      that BOTH writes straight to the live response AND records the value in
 *      the render metadata so it can go into the cache entry.
 *   2. After the render, the app-page handler replays that fresh cache entry's
 *      stored headers onto the SAME response with an unguarded
 *      `res.appendHeader(name, value)` loop.
 *
 * On a HIT step 1 never happens, so the replay is the only write and the header
 * appears once. Next's own `NodeNextResponse.appendHeader` does dedupe, but the
 * replay bypasses it and reaches the raw `http.ServerResponse` method, which
 * does not.
 *
 * Confirmed to be Next itself by elimination: it reproduces identically with
 * the Redis handler, with this repo's LRU fallback, and with NO custom
 * `cacheHandler` and no `cacheMaxMemorySize: 0` at all — i.e. on the stock
 * filesystem ISR cache.
 *
 * `Location` is a single-value field (RFC 9110 §10.2.2), so a second identical
 * line is never wanted: a recipient is entitled to fold repeated field lines
 * into one comma-joined value, which turns `/leeds` into `/leeds, /leeds` —
 * not a URL. The guard is deliberately as narrow as it can be: only
 * `Location`, and only when the value is byte-identical to one already
 * present. A DIFFERENT Location still goes through, because that would be a
 * real bug and hiding it would be worse than the duplicate.
 *
 * Remove this once Next dedupes the replay upstream; the e2e assertion in
 * e2e/routing.spec.ts is what will tell you it is safe to.
 */
export function dedupingAppendHeader(original: AppendHeader): AppendHeader {
  return function patchedAppendHeader(
    this: ServerResponse,
    name: string,
    value: string | readonly string[],
  ) {
    if (name.toLowerCase() === "location") {
      const current = this.getHeader("location");
      const present =
        current === undefined ? [] : (Array.isArray(current) ? current : [current]).map(String);
      const incoming = (Array.isArray(value) ? value : [value]).map(String);
      if (incoming.length > 0 && incoming.every((v) => present.includes(v))) return this;
    }
    return original.call(this, name, value);
  } as AppendHeader;
}

/**
 * Tags the PATCHED function itself, not a module-scoped boolean — the same
 * pattern Next uses for its own prototype patch,
 * `patchSetHeaderWithCookieSupport` in `next/dist/server/lib/patch-set-header.js`.
 *
 * `Symbol.for` interns in the process-wide symbol registry, so every copy of
 * this module — however it got duplicated (a second dependency resolution, a
 * mixed ESM/CJS load, a bundler quirk) — reads and writes the identical
 * symbol key. All of them see the tag on the one shared
 * `ServerResponse.prototype.appendHeader` and none can wrap it twice. A
 * module-scoped `let patched = false` cannot make that promise: each module
 * instance gets its own `patched`, so a second instance would happily wrap an
 * already-wrapped method, and every replayed cache header would then run the
 * dedupe guard twice over.
 *
 * Not covered: `http2.Http2ServerResponse` does not share a prototype chain
 * with `http.ServerResponse`, so this patch would need to be applied there
 * separately. Currently moot — the standalone server this patches speaks
 * HTTP/1.1 only — but worth knowing before reusing this helper anywhere HTTP/2
 * is in play.
 */
const PATCHED = Symbol.for("directory-platform.dedupeLocationHeader.patched");

type TaggedAppendHeader = AppendHeader & { [PATCHED]?: true };

/** Applies the patch once per process. Called from `instrumentation.ts`. */
export function dedupeLocationHeader(): void {
  const current = ServerResponse.prototype.appendHeader as TaggedAppendHeader;
  if (current[PATCHED]) return;

  const patched = dedupingAppendHeader(ServerResponse.prototype.appendHeader) as TaggedAppendHeader;
  Object.defineProperty(patched, PATCHED, { value: true });
  ServerResponse.prototype.appendHeader = patched;
}
