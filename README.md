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
silently when Redis is unreachable. See `docs/spikes/`.

## Local development

```bash
corepack pnpm install
corepack pnpm db:up                    # postgres :5433, redis :6380
DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev \
  corepack pnpm db:migrate
corepack pnpm test
```

Copy `.env.example` to `.env` and fill it in. `validateEnv` fails the boot on a
missing key — a site that starts without its payment config is worse than one
that refuses to start.

## Layout

```
config/       site.config.ts — the only file a clone edits
lib/routing/  slug registry, slugify, PillarScope, resolver
lib/db/       Drizzle schema (40 tables) and queries
lib/features/ build-time flags, route guard, single navigation source
test/         rollback-per-test harness
docs/         spikes and implementation plans
```
