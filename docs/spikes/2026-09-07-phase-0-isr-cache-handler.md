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

---

## Follow-up, 2026-09-08 — the half of the gate the spike did not test

The spike proved that a runtime-regenerated page survives a filesystem wipe.
It did not check what the surviving page *references*, and that turns out to be
where the design leaks.

Cache keys are `nextjs:/<slug>` with no build id, so a redeploy re-serves HTML
produced by the previous build. That HTML links hashed assets —
`/_next/static/chunks/<hash>.css` — and `.next/static` is replaced wholesale on
redeploy. Observed on a container built from this repo: a cached homepage asked
for `/_next/static/chunks/3zwxupz86f3wk.css`, which the running image did not
contain. The page returns 200 and renders unstyled.

"Cache survives redeploy" is only a coherent design if old builds' static output
stays servable. That is precisely what Vercel does, and it is not something a
container gets for free.

### The fix

`docker-entrypoint.sh`: when `STATIC_ASSETS_DIR` is set, the image's
`.next/static` is copied into it **without overwriting** (`cp -Rn`) and
`.next/static` becomes a symlink to it. Each deploy adds its own hashes; the
previous deploy's stay. Unset, the entrypoint does nothing.

**Deploying this means mounting a volume.** The Coolify app needs a persistent
volume at, say, `/data/next-static`, with `STATIC_ASSETS_DIR=/data/next-static`.
Without it you must run `scripts/purge-cache.sh` after every single deploy, and
between the deploy and the purge the site serves unstyled pages.

The volume grows by one build's static output per deploy and is never pruned.
That is deliberate for now — it is small, and pruning it correctly means knowing
which build ids still have live cache entries. Sweep it by hand if it matters.

Two BusyBox details that cost real time, both now commented in the entrypoint:

- `cp -Rn src/. dst/` exits 0 and copies **nothing**. The glob form works.
- The volume Docker creates is root-owned, so the entrypoint runs as root and
  drops to `nextjs` with `su-exec` rather than declaring `USER nextjs`.

`scripts/verify-isr.sh` now covers this: it renames the chunk directory to
simulate a rebuild with new hashes, asserts the cached page's stylesheet 404s
without retention, applies the retention step, and asserts it returns 200.

### Two more things the image got wrong

**The cache handler was not loading at all in the image.** The runner copied
`node_modules/@fortedigital` and `node_modules/@redis` out of a pnpm layout,
where both are symlinks into `node_modules/.pnpm`. In the image they dangled,
the import threw, and Next fell back to a per-container LRU — silently, which is
the same failure mode this spike was written to prevent. Every deploy discarded
the cache the spike proved would survive. The dependency stages now install with
`--config.node-linker=hoisted`, and the runner takes that tree whole.

Verify with `scripts/verify-image.sh`, which builds the image and runs
`docker run --rm IMAGE node -e "import('./cache-handler.mjs')…"`. It cannot be a
`RUN` step in the Dockerfile: importing the handler wants `REDIS_URL`.

**`next build` needs a reachable database.** `/cities` and the city pages
prerender from it, so the "built once in CI with no site secrets" comment on the
Dockerfile is not true of `DATABASE_URL` — the build fails with `ECONNREFUSED`
without one. It is a build arg with a placeholder default; the placeholder is
enough to load the module but not to prerender.

---

## Decision reversed 2026-09-08 — the cache is now cold on deploy

The retention volume above treats the symptom. The cause is that this spike
optimised the wrong thing: **"cache survives redeploy" was never a coherent
goal**, and the phase gate should not have been written that way.

### Why

Cached HTML is not portable across builds. Two things in it are build-specific:

- **Hashed asset paths.** `/_next/static/chunks/<hash>.css`. New build, new
  hash; the old URL 404s and the page renders unstyled. That is the symptom the
  follow-up above chased, and `STATIC_ASSETS_DIR` does genuinely fix it.
- **Server-action ids.** A form in a cached page posts to the action id of the
  build that rendered it. The new build has never heard of it, so **every POST
  from that page fails** until the entry revalidates — up to an hour on listing
  pages. No volume fixes this: the action does not exist in the new bundle.

So the retention volume buys a page that looks right and does not work. Vercel
does not have this problem because it does not serve one build's HTML from
another build's server; each deployment is its own immutable unit.

### What changed

`cache-handler.mjs` derives the build id at runtime — `.next/BUILD_ID` relative
to `process.cwd()` (the standalone server chdirs into `.next/standalone`, where
the build output is copied), then `NEXT_BUILD_ID`, then `"dev"` — and keys every
entry `nextjs:<buildId>:`. The derivation is in `lib/cache/build-id.mjs`, plain
ESM with no dependencies because the standalone server loads the handler without
a bundler, and unit-tested in `lib/cache/build-id.test.ts`.

Observed on the standalone server, two builds against `redis://…/7`:

```
nextjs:kwsdX2O2_JjOKy60mMAFD:/index          <- build 1
nextjs:kwsdX2O2_JjOKy60mMAFD:__sharedTags__
nextjs:g3BTk_zTkf5ky9f01GsSn:/index          <- build 2, same URL, own namespace
nextjs:g3BTk_zTkf5ky9f01GsSn:__sharedTags__
```

Build 2 served `/` fresh: its own build id in the HTML, its own stylesheet at
200, and build 1's stylesheet 404 — untouched, because nothing asks for it.

### What the cache guarantees now

- **Shared across replicas.** Two web containers of the same build share one
  warm cache. This was always the bigger win and it is unaffected.
- **Survives a container or process restart of the same build.** A page
  regenerated at runtime is still there after the container is replaced,
  redeployed at the same commit, or OOM-killed.
- **Cold on deploy, warmed on demand.** A new build starts with an empty
  namespace and fills it as traffic arrives.
- **No cross-build bleed.** A build can only ever read entries it wrote.

### Operational consequence

- **The first hit on each page after a deploy is a render**, not a cache read.
  Sized for this app that is a database query and a React render, not a rebuild
  of the site; the pages that matter warm within seconds of a deploy. If that
  ever becomes a problem the answer is a warming sweep over the sitemap, not a
  cache that outlives its build.
- **Old namespaces need sweeping.** Nothing expires them. Run
  `scripts/purge-cache.sh` as a Coolify post-deployment command: with no
  arguments it keeps `.next/BUILD_ID` — the running build — and deletes every
  other `nextjs:*` namespace, including the un-namespaced `nextjs:/path` keys
  written before this scheme.
- **Keep `STATIC_ASSETS_DIR`.** It is no longer load-bearing for correctness,
  but a client that already holds an old page — an open tab, a bfcache entry, a
  prefetch in flight — still asks for the old build's assets. Retention keeps
  those 200 instead of 404 while the client re-validates. It does nothing for
  server-action skew, which is why it could not be the whole answer.

### The gate wording

> "Cache handler survives a redeploy with a warm cache, or fallback chosen."

Read as written — a redeploy does not cold-start the ISR cache — this is no
longer the goal and the code deliberately does the opposite. The gate is met by
the second clause and by what the cache is actually for: shared across replicas,
warm across restarts of one build, and a working LRU fallback when Redis is
down. `scripts/verify-isr.sh` now asserts that, and fails with the original
symptom if the build-agnostic key prefix is restored.
