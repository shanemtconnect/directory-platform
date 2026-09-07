# Phase 0 spike — Redis-backed ISR cache handler

**Date:** 2026-09-07 · **Result: PASS**, with three corrections to the brief.

**Gate:** "Cache handler survives a redeploy with a warm cache, or fallback chosen."

## Verdict

Passed. Evidence below. Working handler saved to `reference/cache-handler.mjs`,
reproducible test to `reference/isr-redeploy-test.sh`.

```
T1 (build-time prerender): 1788817461791-sdxth35l
T2 (runtime regenerated):  1788817461858-utv4hb8s
redis keys after T2: 4   -> spike:/isr, spike:__sharedTags__,
                            spike:__sharedTagsTtl__, spike:__revalidated_tags__
--- wiped .next, restored the pristine post-build copy, restarted ---
T3 (after redeploy):       1788817461858-utv4hb8s

PASS: runtime-regenerated page survived a filesystem wipe -> served from Redis
```

`T2` was generated at runtime, so it exists nowhere in the build output. `T3 == T2`
from a pristine filesystem is only possible if the entry came from Redis.

## Correction 1 — the brief's package cannot be used at all

`@neshca/cache-handler` is **abandoned and incompatible**:

- Last publish `1.9.0`, last modified **2024-11-26** — 21 months stale.
- `peerDependencies: { next: ">= 13.5.1 < 15" }`. It does not support Next 15,
  let alone 16. Its own successor's README states this plainly.

The brief specified it for Phase 1. It would have failed on install.

## Correction 2 — use the fork, and the version depends on the Next major

`@fortedigital/nextjs-cache-handler` — standalone since 2.0.0, actively maintained
(3.3.0 published 2026-08-12).

| Next | Required handler version |
|---|---|
| 15 (`15.5.25` final) | `2.5.3` (`peer: next >=15.2.4`) |
| 16 (`16.3.4` current) | `3.3.0` (`peer: next >=16.1.5`) |

**Mandatory, not optional:** on Next >= 16.3.0, handler versions below 3.3.0 fail to
populate `segmentData` when restoring the initial cache, so the App Router client
gets an unparseable `/_tree` prefetch response and **retries indefinitely**. Pin
`>=3.3.0`.

## Correction 3 — recommend Next 16, not Next 15

The brief says Next 15 under "do not substitute", but 15 is now the previous major.

- Next 16.3.4 is current stable.
- Better Auth 1.7.3 (published 2026-09-06) declares `next: ^14 || ^15 || ^16`.
- Drizzle ORM 0.45.2 matches Better Auth's peer range exactly.
- The cache handler's 3.x line — where all current development happens — requires 16.
  Choosing 15 pins us to the 2.x maintenance branch on day one.

Every caching feature this platform actually uses is ✅ on 16 per the handler's
compatibility matrix: ISR, `revalidatePath`, `generateStaticParams`,
`unstable_cache`, fetch tags, both Redis clients. The ❌ column is confined to
Next 16's *new* `use cache` / `cacheComponents` model, which this design does not
use and the brief never mentions.

**One API change to carry into the plan:** `revalidateTag(tag)` becomes
`revalidateTag(tag, cacheLife)` in Next 16 (`'max' | 'hours' | 'days'`), and
`updateTag()` is available in Server Actions. Affects plan item H7 (daily shuffle).

## The landmine this spike existed to find

My first wiring followed the package's own Quick Start — top-level
`await client.connect()` in `cache-handler.mjs`. **`next build` hung indefinitely**
because Redis was momentarily down. No error, no timeout, no failure — just a build
that never returns. In CI that is an unexplained job timeout.

Two things fix it, both now in `reference/cache-handler.mjs`:

1. **Never touch Redis during the build.** Guard on
   `PHASE_PRODUCTION_BUILD !== process.env.NEXT_PHASE`. The build needs no cache.
2. **Fall back to local LRU when Redis is unreachable**, with a `connectTimeout` and
   a bounded `reconnectStrategy`. A site with a sick Redis must still boot and serve.

The Quick Start block is labelled "not meant for production use" and it means it.

## Environment notes

- Node **v24.13.1** — above the handler's `>=22` floor and the brief's `>=20`.
- TypeScript **7.0.2** installed and the build type-checked clean in 133 ms.
- `pnpm` is **not installed globally**. `corepack pnpm` works (12.3.4); the
  `corepack enable pnpm` symlink into `/usr/local/bin` needs Shane's password.
- Docker Desktop is installed but was **not running**. Started for this spike.
  It also SIGTERM'd the first Redis container during its own startup — worth knowing
  before blaming code for a dead container.
- Build of a 2-page app: **1.2 s** compile, ~4 s total.
