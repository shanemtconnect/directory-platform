# Directory Platform

A reusable, config-driven city directory built to be cloned into a new niche in
under a day. Change one config file, seed cities and categories, deploy.

**Status:** Phase 1 of 8 — foundation. 91 tests passing.

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

**ISR survives redeploys.** The cache handler is Redis-backed and guards against
connecting during `next build` — without that guard the build hangs forever and
silently when Redis is unreachable. Surviving HTML still points at the hashed
assets of the build that made it, so the deploy has to keep those servable; see
`STATIC_ASSETS_DIR` under Deploy, and `docs/spikes/`.

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

**Mount a volume at `STATIC_ASSETS_DIR`.** This is not optional tuning. The ISR
cache is Redis-backed and deliberately outlives a deploy, but the HTML it holds
references hashed asset paths from the build that produced it. Replace
`.next/static` on redeploy and every cached page links dead CSS and JS. Give the
Coolify app a persistent volume — `STATIC_ASSETS_DIR=/data/next-static` — and
`docker-entrypoint.sh` merges each new build's assets in beside the old ones.

Without that volume you must run `scripts/purge-cache.sh` after **every** deploy,
and the site serves unstyled pages until you do.

## Layout

```
config/       site.config.ts — the only file a clone edits
lib/routing/  slug registry, slugify, PillarScope, resolver
lib/db/       Drizzle schema (40 tables) and queries
lib/features/ build-time flags, route guard, single navigation source
test/         rollback-per-test harness
docs/         spikes and implementation plans
```
