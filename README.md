# Directory Platform

A reusable, config-driven city directory built to be cloned into a new niche in
under a day. Change one config file, seed cities and categories, deploy.

**Status:** Phase 1 of 8 — foundation, plus a review-fixes pass. Vitest covers
the units and the queries (rollback-per-test, against a real Postgres);
Playwright runs a smoke suite against the standalone production build, twice —
once with every optional flag off and once with all of them on.

## Stack

Next.js 16 (App Router, `output: 'standalone'`) · TypeScript strict · Drizzle +
PostgreSQL 16 · Redis-backed ISR via `@fortedigital/nextjs-cache-handler` ·
Tailwind 4 · Vitest · PayPal Subscriptions · Cloudflare R2 + CDN

## The idea

One codebase, many directories. Everything niche-specific lives in
`config/site.config.ts` or in seeded database rows — nothing in a component. A
clone edits one file.

Two site shapes share one router:

- **`niche-national`** — one entity type, many cities. `/[city]` is the pillar.
- **`local-multi-vertical`** — one town, many business types. `/[vertical]` is
  the pillar.

## Design notes worth knowing

**The slug registry.** A single `slugs` table indexed on
`(parent_scope, slug)` is both the router's index and the collision guard.
`/manchester/barn-venues` is ambiguous between a category and a listing in any
naive design; here a listing simply cannot take a category's slug inside the
same city, because the database won't allow it. One lookup per segment returns
the `kind`, so there is no ordered fallback and no mode-specific branching.

**Cities earn indexing.** `cities.is_indexable` defaults to `false` and is only
flipped once a city clears a listing threshold and has real intro copy. Thin
one-listing city pages are how directories sink their own domain.

**Ownership and payment are separate axes.** `claim_status`
(unclaimed → claimed → verified) and `tier` (free/essential/premium) are
different columns, so a cancellation can drop a badge without touching a tier.

**The ISR cache is per build, and that is deliberate.** It is Redis-backed and
keyed `nextjs:<buildId>:`, so it is shared across replicas and survives a
container restart, but a deploy starts cold. Cached HTML belongs to the build
that rendered it: it links that build's hashed assets, and its forms post to
that build's server-action ids, which the next build does not have. Serving it
across a deploy gives an unstyled page whose every form POST fails. The handler
also guards against connecting during `next build` — without that guard the
build hangs forever and silently when Redis is unreachable. See
`docs/spikes/2026-09-07-phase-0-isr-cache-handler.md`.

**A failed Redis connect at boot falls back to an in-process LRU cache for the
rest of that process's life** — no retry, no later hot-swap back to Redis —
and past the one log line at boot, `cache-handler.mjs` re-logs
`[cache] STILL FALLING BACK TO LRU` every five minutes for as long as it stays
in fallback, so restart the container once Redis is reachable again rather
than waiting for it to notice on its own.

## Local development

```bash
corepack pnpm install
corepack pnpm db:up                    # postgres :5433, redis :6380
DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev \
  corepack pnpm db:migrate
corepack pnpm test
```

Copy `.env.example` to `.env` and fill it in. **Five** keys are required to boot
and `validateEnv` refuses to start without them (`RUNTIME_ENV` in
`config/validate.ts`) — `NEXT_PUBLIC_SITE_URL`, `DATABASE_URL`, `REDIS_URL`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`. The last two are there because auth is
wired: without the secret every session cookie is signed with a key the next
boot does not have, and without the URL the callbacks point at the wrong origin.
The rest of `.env.example` is groundwork for later phases (R2, PayPal, email)
and is listed in `RUNTIME_ENV_PHASE5` in `config/validate.ts`, along with the
phase that turns each group on. Turnstile and MapTiler stay optional: both
degrade rather than break.

`NEXT_PUBLIC_*` values are inlined by `next build`, so setting one at boot does
nothing. They are build args, and a missing one warns rather than failing.

### `SITE_ENV` is a build arg

Only the literal `production` is production. Anything else — `staging`, a typo,
an empty value, an unset variable — is staging, and staging is `noindex`
site-wide. Indexing is opted into on purpose: a production site that forgot the
variable serves `noindex` until someone notices and rebuilds, while a staging
site that forgot it gets its whole duplicate copy of the directory indexed, and
that takes months to undo.

It is **build-time**. The `X-Robots-Tag: noindex` header comes from
`next.config.ts` `headers()`, which Next evaluates during `next build` and
writes into `.next/routes-manifest.json`; the standalone server reads that file
and never re-runs `headers()`. `app/robots.ts` is `force-dynamic` and does read
the variable per request. So changing only the container's environment gives a
site whose `robots.txt` says `Allow: /` while every response still says
`noindex` — **flipping staging → production is a rebuild**, with
`--build-arg SITE_ENV=production`.

## Deploy

The image builds two targets from one Dockerfile: `runner` (the app) and
`worker` (the same image running `worker/index.ts` under tsx, with
`WORKER_ENABLED=true`).

**Set `WORKER_ENABLED=true` only on the worker service.** A shared env file
that leaks it into the web container's environment (even as `=false`) is
enough to disable the web container's static-asset retention below —
`docker-entrypoint.sh` only runs it when `WORKER_ENABLED` is unset or not the
literal string `true`.

```bash
docker build --target runner \
  --build-arg NEXT_PUBLIC_SITE_URL=https://example.co.uk \
  --build-arg SITE_ENV=production \
  --build-arg NEXT_PUBLIC_MAPTILER_KEY=… \
  --build-arg NEXT_PUBLIC_MEDIA_URL=https://media.example.co.uk \
  -t directory-platform .

./scripts/verify-image.sh    # cache handler loads, assets retained, worker runs
```

`NEXT_PUBLIC_SITE_URL` and `SITE_ENV` are the two that matter and neither can be
corrected at boot: the first is inlined into the client bundle, the second is
frozen into `routes-manifest.json` (see above). The other two are optional and
warn rather than failing.

**No `DATABASE_URL`.** The build does not need one. `/`, `/cities` and
`/categories` are ISR pages that read Postgres, but they ask
`prerenderingWithoutDatabase()` first (`lib/db/build-phase.ts`) and prerender an
empty-state shell when there is nothing to read; ISR fills in the real page on
the first request, where a database is guaranteed because `instrumentation.ts`
refuses to boot a server without one. The city and category catch-all routes
never needed one: their `generateStaticParams` return `[]`. The runner gets its
`DATABASE_URL` at boot.

**Staging needs a Turnstile key too.** `lib/spam/turnstile.ts` skips
verification only when `NODE_ENV !== "production"`, and a staging container is a
production build — so without `TURNSTILE_SECRET_KEY` it fails closed and rejects
every enquiry. Cloudflare's published always-pass testing keys are the right
thing there: `TURNSTILE_SITE_KEY=1x00000000000000000000AA`,
`TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA`.

### Migrating: `MIGRATE_ON_BOOT=true` on the web service

Set `MIGRATE_ON_BOOT=true` in the web service's environment. Coolify's
**pre-deployment command** executes inside the *previous* running container,
not the new one — on a first deploy there is no previous container so it never
runs at all, and on a later deploy it would run the OLD image's
`scripts/migrate.mjs` against the NEW schema. `docker-entrypoint.sh` runs the
migration inside the new container itself, before the server starts serving,
which is the only place that is both the new image and pre-traffic. A failed
migration aborts boot (non-zero exit, no server) rather than serving a broken
schema — a container that starts ahead of its own migration does not merely
break the worker: `createSubmission` inserts into `job_queue` inside the same
transaction as the enquiry, so a missing column takes down every enquiry form
on the site.

For a manual or one-off migration (e.g. against a database you're inspecting
by hand, or a container started without `MIGRATE_ON_BOOT`), run the same
script directly:

```
node scripts/migrate.mjs
```

Not `pnpm db:migrate`. That is `drizzle-kit migrate`, and `drizzle-kit` is a
devDependency the prod-only runner tree does not contain. `scripts/migrate.mjs`
is plain ESM calling the same `migrate()` from
`drizzle-orm/postgres-js/migrator` over the same `drizzle/` folder, importing
only `drizzle-orm` and `postgres` — both runtime dependencies the image already
carries for the app. The two write identical `drizzle.__drizzle_migrations`
rows; `scripts/verify-image.sh` runs the script inside the built image against a
throwaway database on every check.

Re-running it is a no-op (`already up to date`), and it exits 1 with a message
rather than hanging if `DATABASE_URL` is unset or the database is unreachable.

### Seeding: from the worker container

```bash
docker exec <worker> ./node_modules/.bin/tsx scripts/seed-cli.ts
```

Once, against a freshly migrated database. It runs in the **worker**, not the
runner: `scripts/seed-cli.ts` is TypeScript and needs tsx, which only the
worker's dev-inclusive dependency tree has. With no argument the niche defaults
to `slugify(siteConfig.entity.plural)`, which is also the directory name under
`seeds/` — so a clone renames one folder and the command is unchanged. The seed
is idempotent: rows already present are reported as skipped.

**The app sweeps stale namespaces itself — there is nothing to configure.**
Each build gets its own `nextjs:<buildId>:` namespace in Redis and nothing
expires the previous one, so a minute after a new container connects to Redis
it SCANs `nextjs:*` and deletes every key outside its own prefix. It is
fire-and-forget: the site serves whether or not the sweep succeeds, and the
result is logged next to `[cache] key prefix:`.

The delay is what makes it safe during a rolling deploy — the previous replica
is still serving from its own namespace until traffic swaps, and sweeping
immediately would pull the cache out from under it. `CACHE_SWEEP_DELAY_MS`
overrides it (default `60000`); raise it if your deploys take longer to drain.

**One Redis database index, or one `CACHE_NAMESPACE`, per site.** That sweep
`DEL`s every key under `<namespace>:*` that is not the running build's, so two
clones sharing both a Redis database and a namespace delete each other's cache
on every deploy — invisibly, because a swept key looks exactly like a cold one.
Either give each site its own database index (`redis://host:6379/3`,
`…/4`, …) or set `CACHE_NAMESPACE` per site; either is enough. It is optional
and defaults to `nextjs`, takes letters, digits, `_` and `-` up to 64
characters, and a value outside that fails the boot rather than quietly
reverting to the shared default. `scripts/purge-cache.sh` reads the same
variable.

Do **not** wire `scripts/purge-cache.sh` in as a post-deployment command. The
runner image is `node:24-alpine` carrying the standalone server, the migrations
and `scripts/migrate.mjs` — and nothing else. No bash, no `redis-cli`, none of
the rest of `scripts/`, so the purge script cannot run there. It is for a host
that has a `redis-cli` and a checkout, when you want to purge by hand:

```bash
REDIS_URL="$REDIS_URL" ./scripts/purge-cache.sh
```

With no arguments it keeps the build id in `.next/BUILD_ID` and deletes every
other namespace under `CACHE_NAMESPACE` (default `nextjs`). `KEEP_BUILD_ID=none` purges everything instead, which is the
way to force every page to re-render now. `DRY_RUN=1` lists without deleting.

**Expect a cold cache after a deploy.** The first request to each page renders
it; there is no way around that, and no way to avoid it that does not mean
serving the previous build's HTML. Warm the pages that matter by hitting them
if you care about the first visitor.

**Mount a volume at `STATIC_ASSETS_DIR`.** No longer load-bearing for
correctness, but still worth having: a client that already holds a page from the
previous build — an open tab, a bfcache entry, a prefetch in flight — asks for
that build's hashed assets, and without retention they 404 until it reloads.
Give the Coolify app a persistent volume, `STATIC_ASSETS_DIR=/data/next-static`,
and `docker-entrypoint.sh` merges each new build's assets in beside the old
ones. It grows by one build's static output per deploy and is never pruned;
sweep it by hand when it matters.

## Layout

```
config/          site.config.ts — the only file a clone edits
lib/routing/     slug registry, slugify, PillarScope, resolver
lib/db/          Drizzle schema (40 tables) and queries
lib/features/    build-time flags, route guard, single navigation source
seeds/<plural>/  cities, categories and listings CSVs, named after the entity
scripts/         seed, reseed-dev, cache purge, the niche-string guard
content/blog/    posts; content/blog/demo/ loads only in demo mode
e2e/             Playwright specs, run against the standalone build
test/            rollback-per-test harness
docs/            spikes and implementation plans
```

Two things a clone touches beyond `site.config.ts`: rename `seeds/venues/` to
match the new `entity.plural` and replace the three CSVs inside it, and
regenerate the banned-word list in `scripts/check-niche-strings.sh` so the new
site bans its own niche words rather than the old site's.
