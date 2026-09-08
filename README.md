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

## Local development

```bash
corepack pnpm install
corepack pnpm db:up                    # postgres :5433, redis :6380
DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev \
  corepack pnpm db:migrate
corepack pnpm test
```

Copy `.env.example` to `.env` and fill it in. Three keys are required to boot
and `validateEnv` refuses to start without them — `NEXT_PUBLIC_SITE_URL`,
`DATABASE_URL`, `REDIS_URL`. The rest of `.env.example` is groundwork for later
phases (auth, R2, PayPal, email) and is listed in `RUNTIME_ENV_PHASE5` in
`config/validate.ts`, along with the phase that turns each group on. Turnstile
and MapTiler stay optional: both degrade rather than break.

`NEXT_PUBLIC_*` values are inlined by `next build`, so setting one at boot does
nothing. They are build args, and a missing one warns rather than failing.

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
  --build-arg NEXT_PUBLIC_MAPTILER_KEY=… \
  --build-arg NEXT_PUBLIC_MEDIA_URL=https://media.example.co.uk \
  --build-arg DATABASE_URL=postgres://…  -t directory-platform .

./scripts/verify-image.sh    # cache handler loads, assets retained, worker runs
```

`DATABASE_URL` is a build arg because `next build` prerenders `/`, `/cities`
and `/categories` from the database — the build genuinely queries it. (The
city and category catch-all routes are not among these: their
`generateStaticParams` return `[]`, so they need no database.) `docker build`
now fails fast with a clear message if the arg is missing, rather than dying
partway through prerendering on `ECONNREFUSED`. It is not baked into the
runner; that gets its own at boot.

### Migrating: the Coolify pre-deployment command

```
node scripts/migrate.mjs
```

Set that as the app's **pre-deployment command**. Coolify runs it in the newly
built `runner` image with the service's environment, so it picks up
`DATABASE_URL` on its own, and a non-zero exit aborts the deploy before the new
container takes traffic — which is the whole point. A container that starts
ahead of its own migration does not merely break the worker: `createSubmission`
inserts into `job_queue` inside the same transaction as the enquiry, so a
missing column takes down every enquiry form on the site.

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

Do **not** wire `scripts/purge-cache.sh` in as a post-deployment command. The
runner image is `node:24-alpine` carrying the standalone server, the migrations
and `scripts/migrate.mjs` — and nothing else. No bash, no `redis-cli`, none of
the rest of `scripts/`, so the purge script cannot run there. It is for a host
that has a `redis-cli` and a checkout, when you want to purge by hand:

```bash
REDIS_URL="$REDIS_URL" ./scripts/purge-cache.sh
```

With no arguments it keeps the build id in `.next/BUILD_ID` and deletes every
other namespace. `KEEP_BUILD_ID=none` purges everything instead, which is the
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
