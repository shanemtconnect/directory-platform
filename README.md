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

**Import from a URL on `/add-listing`** (`siteConfig.listing.importFromUrl`,
on by default). A "Paste the address" box above the form fetches the business's
own page through the SSRF-guarded fetcher in `lib/net/safe-fetch.ts` (the same
one the badge backlink check uses), reads its OpenGraph and JSON-LD, and
prefills the form. It never submits: the person checks every field and the
submission still passes Turnstile. Ten look-ups an hour per connection.

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
One more group is required **conditionally**: set `PAYPAL_CLIENT_ID` and the
site is taking money, so `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` and the
`PAYPAL_PLAN_*` ids must be there too or the boot refuses (`BILLING_ENV` in
`config/validate.ts`). Everything else — R2, email, Turnstile, MapTiler,
monitoring — is optional and degrades rather than breaks. The full list, with
what each unset variable costs you, is under [Environment
variables](#environment-variables).

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

## Environment variables

Every variable the code reads, in one place. "Read at" is the trap to watch:
**build** means `next build` inlines it (a `NEXT_PUBLIC_` prefix, or
`SITE_ENV`), so setting it on the container later does nothing; **boot** means
the container reads it, and can be changed with a restart. The authoritative
lists are in `config/validate.ts` — `BUILD_ENV`, `BUILD_ENV_OPTIONAL`,
`RUNTIME_ENV`, `BILLING_ENV_SWITCH` + `BILLING_ENV`, `OBSERVABILITY_ENV_OPTIONAL`
and `RUNTIME_ENV_PHASE5` — and `validateEnv` is what refuses a build or a boot.

Generate every secret the same way: `openssl rand -hex 32`.

### Required

| Variable | Read at | Read by | When unset |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | **build** and boot | Dockerfile `ARG`; `lib/site-env.ts`, `lib/auth/server.ts`, `lib/auth/client.ts`, `worker/jobs/notify.ts` — canonicals, sitemap, JSON-LD, auth origin, links in mail | Build fails (`BUILD_ENV`); boot refuses (`RUNTIME_ENV`) |
| `DATABASE_URL` | boot | `lib/db/client.ts` (opens on first use, not on import), `scripts/migrate.mjs`, `scripts/seed-cli.ts`, `scripts/outreach-batch.ts` | Boot refuses. Never needed at build |
| `REDIS_URL` | boot | `cache-handler.mjs` (ISR), `lib/redis/client.ts` (the one shared handle behind `lib/spam/rate-limit.ts`, `lib/stats/redis.ts` and `lib/badge/counters.ts`), `/api/health` | Boot refuses. In `next dev` the health route reports `redis: "absent"` and the view counters are off. While Redis is connecting or in its 30 s down-cooldown, view and badge counts are held in a bounded in-process buffer (10 000 keys, oldest dropped past that) and written when the client is back — delayed, not lost — and rate limits count per process |
| `BETTER_AUTH_SECRET` | boot | `lib/auth/server.ts` — signs session cookies | Boot refuses |
| `BETTER_AUTH_URL` | boot | `lib/auth/server.ts` (callback origin), `worker/jobs/notify.ts` (allowed link origins) | Boot refuses. The code would fall back to `NEXT_PUBLIC_SITE_URL`; `validateEnv` requires it anyway |
| `SITE_ENV` | **build** (and re-read per request) | `next.config.ts` `headers()`, `config/validate.ts` (`staging` waives the placeholder guard), `lib/site-env.ts` (robots.txt, sitemap) | Treated as `staging`: `noindex` site-wide. Only the literal `production` is production — see [`SITE_ENV` is a build arg](#site_env-is-a-build-arg) |
| `WORKER_ENABLED` | boot | `worker/index.ts`, `docker-entrypoint.sh` | Worker container exits 0 at once. Set `true` on the worker service **only**; on the web service leave it unset (see Deploy) |

### Billing — required once `PAYPAL_CLIENT_ID` is set

`PAYPAL_CLIENT_ID` is the switch (`BILLING_ENV_SWITCH`). With it blank the site
runs free listings only and none of the rest is checked. With it set, every
variable in `BILLING_ENV` has to be there or the boot refuses — web and worker
both. The `PAYPAL_PLAN_*` names are derived from `config/site.config.ts`: one
per tier with a price above zero, per interval, upper-cased. For the shipped
config (`essential`, `premium`) that is the four below;
`scripts/paypal-setup.ts` prints them.

| Variable | Read at | Read by | When unset |
| --- | --- | --- | --- |
| `PAYPAL_CLIENT_ID` | boot | `lib/billing/paypal.ts` | Billing off: `/checkout/…` shows a "not set up" panel, `/api/webhooks/paypal` answers 503 (PayPal retries), `subscription-sync` and `renewal-reminders` are no-ops |
| `PAYPAL_CLIENT_SECRET` | boot | `lib/billing/paypal.ts` | Boot refuses when the switch is set |
| `PAYPAL_WEBHOOK_ID` | boot | `lib/billing/paypal.ts` — `verifyWebhookSignature`, which fails closed | Boot refuses when the switch is set. A *wrong* id is the dangerous case: every delivery is rejected 401 and nothing looks broken — see [Operating the site](#operating-the-site) |
| `PAYPAL_PLAN_ESSENTIAL_MONTHLY` `PAYPAL_PLAN_ESSENTIAL_ANNUAL` `PAYPAL_PLAN_PREMIUM_MONTHLY` `PAYPAL_PLAN_PREMIUM_ANNUAL` | boot | `lib/billing/plans.ts` — maps a tier×interval to a PayPal plan id and back | Boot refuses when the switch is set. An id not in the environment never grants a tier |
| `PAYPAL_ENV` | boot | `lib/billing/paypal.ts`, `scripts/paypal-setup.ts` | Sandbox. Only the literal `live` hits `api-m.paypal.com`; forgetting it takes test money, which is the recoverable mistake |
| `PAYPAL_PLAN_SPONSOR_MONTHLY` | boot | `lib/ads/billing.ts` — the sponsor-rail plan `scripts/paypal-setup.ts` also creates | **Optional, not part of the boot group.** Unset: `/advertise/sponsor` still takes a campaign but sends nobody to PayPal; the page says payment is arranged by email |

### Optional — the feature degrades

| Variable | Read at | Read by | When unset |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_MAPTILER_KEY` | **build** | `components/map/ListingMap.tsx` | Build warns (`BUILD_ENV_OPTIONAL`); the map is not rendered, the listings still are |
| `NEXT_PUBLIC_MEDIA_URL` | **build** | `app/[...segments]/page.tsx` | Build warns; image URLs resolve against the site's own origin |
| `NEXT_PUBLIC_DEMO_MODE` | **build** | `lib/blog/demo.ts` | Demo posts in `content/blog/demo/` are not loaded. Only the exact string `true` loads them |
| `TURNSTILE_SITE_KEY` | boot | `app/add-listing`, `app/leave-review/[listingId]`, `app/report/[id]`, `app/remove/[id]` — rendered into the widget | No widget on those forms |
| `TURNSTILE_SECRET_KEY` | boot | `lib/spam/turnstile.ts` | `NODE_ENV !== "production"`: verification skipped. Production (staging included): **every form submission rejected**, logged once. Use Cloudflare's always-pass test keys on staging (see Deploy) |
| `RESEND_API_KEY` `EMAIL_FROM` | boot | `lib/email/sender.ts` | Either blank: warns once, sends nothing, returns `not-configured`. Enquiries are still saved; the queue looks healthy |
| `ADMIN_NOTIFICATION_EMAIL` | boot, worker | `worker/jobs/notify.ts` | Warns once; admin-facing notifications (new submission, claim, report…) are dropped. Owner-facing mail is unaffected |
| `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` | boot | `lib/media/r2.ts`, `lib/media/claim-docs.ts` | Claim-by-document is not offered (`claimDocsConfigured()` is false); any media call fails |
| `R2_BUCKET_MEDIA` | boot, worker | `worker/jobs/derivatives.ts` | The derivatives job fails on every pending image, every minute, until it is set |
| `R2_BUCKET_CLAIM_DOCS` | boot | `lib/media/claim-docs.ts`, `worker/jobs/purge-claim-docs.ts` | Claim-by-document is not offered; the purge job finds nothing and says so |
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` | boot | `lib/auth/server.ts` | No Google sign-in button. Both are needed for it to appear |
| `INTERNAL_REVALIDATE_SECRET` | boot, **web and worker, same value** | `app/api/internal/revalidate/route.ts`, `lib/revalidate/client.ts` | The route 404s; the worker logs once and skips; pages the worker changed (tier lapse, badge boost) stay stale until their ISR window turns over |
| `CACHE_NAMESPACE` | boot | `lib/cache/build-id.mjs` via `cache-handler.mjs`; `scripts/purge-cache.sh` | `nextjs`. Letters, digits, `_`, `-`, up to 64 chars — anything else **fails the boot** rather than reverting to the shared default |
| `CACHE_SWEEP_DELAY_MS` | boot | `lib/cache/sweep.mjs` via `cache-handler.mjs` | `60000` |
| `NEXT_BUILD_ID` | boot | `lib/cache/build-id.mjs`, `lib/observability/build-id.ts` | `.next/BUILD_ID` is read first; this is the fallback; then `dev` |
| `MIGRATE_ON_BOOT` | boot | `docker-entrypoint.sh` — web role only | No migration at boot. Set `true` on the web service (see Deploy) |
| `STATIC_ASSETS_DIR` | boot | `docker-entrypoint.sh` — web role only | No asset retention across deploys. Set but not writable: **refuses to boot** |
| `PORT` `HOSTNAME` | boot | the standalone server; Dockerfile sets `3000` / `0.0.0.0` | Those defaults |
| `ADS_ENABLED` | boot (read per request) | `lib/ads/policy.ts` — the sponsor rails kill switch | Follows `siteConfig.ads.enabled` (off in the template). The literal `false` hides every rail whatever the config says; the literal `true` shows them over a config that has them off — for checking a staging build, and for the e2e suite. Rails never appear on the home page, and never with real cards unless `SITE_ENV=production` (staging shows a labelled placeholder) |
| `SITE_FLAGS_OVERRIDE` | **build** | `config/flag-variants.ts` | Features come from `site.config.ts`. `on`/`off` exist for the two CI builds (`build:flags-on`, `build:flags-off`) and for staging image builds (Coolify build arg, so every module renders for review). Ignored under `SITE_ENV=production` — enforced in `resolveFeatures()`, with a build-time warning — so it cannot flip flags on a real site |
| `BETTER_AUTH_RATE_LIMIT` | boot | `lib/auth/server.ts` | Rate limiting on. Only the literal `off` disables it, and only `playwright.config.ts` sets that |
| `STATS_SEEN_SALT` | boot | `lib/stats/counters.ts` — salts the `sha256(ip, day, salt)` digest that stands in for a visitor's address in the one-view-per-day mark (`stats:seen:<day>:<digest>:<listing>`) | `BETTER_AUTH_SECRET` is used instead. Redis never holds a raw address either way; set this only to rotate the two independently |

### Monitoring variables

All optional, never enforced, and detailed in [Monitoring](#monitoring):
`NEXT_PUBLIC_SENTRY_DSN` (**build**, browser errors), `SENTRY_DSN` (boot, server
errors, falls back to the public one), `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` (**build**,
no script when unset), `UPTIME_PUSH_URL` (boot, worker only).

### Not yours to set

`NODE_ENV`, `NEXT_PHASE` and `NEXT_RUNTIME` are set by Next itself and read by
`lib/spam/turnstile.ts`, `lib/db/build-phase.ts`, `lib/stats/redis.ts` and
`instrumentation.ts` to tell a build from a server. `TEST_DATABASE_URL`
(`test/db.ts`), `E2E_PORT` (`playwright.config.ts`), `SWEEP_TEST_REDIS_URL`
and the `DB_*` / `POSTGRES_CONTAINER` knobs of the two database shell scripts
are test-only. `GEOCODING_API_KEY` and a non-public `MAPTILER_KEY` appear in
`.env.example` but nothing under `lib/`, `app/`, `worker/` or `config/` reads
either — the map reads `NEXT_PUBLIC_MAPTILER_KEY`.

Variables a script reads for itself (`COOLIFY_*`, `SMOKE_*`, `KEEP_BUILD_ID`,
`DRY_RUN`, …) are listed with that script under [Scripts](#scripts).

### Which header the client address comes from

Rate limiting, the one-view-per-day mark, the audit `ip` column and the auth
limiter all key on `clientIp()` in `lib/spam/client-ip.ts`, which reads, in order:

1. **`CF-Connecting-IP`** — only when `TRUST_CF_CONNECTING_IP=true`. Behind
   Cloudflare it is the one address a visitor cannot choose (Cloudflare sets it
   on every request and strips any copy the visitor sent), and the last
   `X-Forwarded-For` hop is Cloudflare's own edge, which would put every
   visitor in one bucket. **Without Cloudflare nothing strips it**, so a client
   could send the header and name its own bucket on every request — which is
   why it is off by default and must never be switched on for an origin that
   is reachable other than through Cloudflare.
2. The **last** `X-Forwarded-For` hop — the one the origin proxy (Coolify's
   Traefik, nginx) appended. The left of the list is whatever the client wrote.
3. `X-Real-IP`.
4. Nothing: the request is served, not counted, and logged once in production
   (`rateLimitSubject`), because that means the proxy is not passing headers.

## Testing

Three databases, on purpose — `corepack pnpm db:up` starts the one Postgres
that holds all of them.

| Database | Who owns it | Built by |
| --- | --- | --- |
| `directory_dev` | your `next dev` | `bash scripts/reseed-dev.sh` |
| `directory_test` | the unit suite, one rolled-back transaction per test | `pnpm db:migrate` against it |
| `directory_e2e` | Playwright | `corepack pnpm test:e2e:db` |

```bash
corepack pnpm test                     # units, TEST_DATABASE_URL
corepack pnpm test:e2e:db              # create/migrate/seed directory_e2e
corepack pnpm test:e2e                 # Playwright, against directory_e2e
corepack pnpm test:e2e:db -- --reset   # start that database again from the seeds
```

The e2e suite **writes**. `e2e/location.spec.ts` submits a listing through the
real form, which creates a city, a slug and a pending listing — that is the
behaviour under test, and mocking it would prove nothing. So it gets its own
database rather than scribbling on the one you are developing against, and the
spec deletes what it created in an `afterAll` so repeat runs do not accumulate.
`playwright.config.ts` defaults to `directory_e2e`; `DATABASE_URL` still wins,
which is how CI points it at the service container.

Two things to know before a local run: `E2E_PORT` overrides the default 3200,
which matters because `reuseExistingServer` will otherwise hand your suite
whatever is already listening there — another worktree's build, quietly testing
somebody else's code. And the submission form is rate-limited to three per IP
per hour; `redis-cli -n <db> FLUSHDB` clears it.

## Audits

`corepack pnpm audit:pages` runs Lighthouse (mobile and desktop) and axe-core
against a running **production** build and fails on a miss: SEO ≥ 95,
accessibility ≥ 95, best practices ≥ 90, performance ≥ 80, and any `serious`
or `critical` axe violation. It audits one page of every type the site
serves — home, the indexes, a city pillar, a city + category pillar, a
listing, a second page of results, search, the forms (add, claim, report,
review, login, signup, forgot-password), the legal pages, a blog post and the
404 — and derives every slug from the sitemap shards, so it works unchanged
on a clone with different data. Start the server the way Playwright does
(build, assemble the standalone bundle, `node .next/standalone/server.js`
with the env from `playwright.config.ts`), then:

```bash
AUDIT_BASE_URL=http://localhost:3241 corepack pnpm audit:pages
```

It prints a table, writes `audit-report.json` (gitignored; failing audits
carry their offending nodes) and exits 1 on any miss. `AUDIT_PAGES=home,login`
narrows a run while you chase one fix; `AUDIT_FORM_FACTORS=desktop` skips
mobile; `AUDIT_MIN_PERFORMANCE` and friends move the bars; `CHROME_PATH`
points Lighthouse at a browser (it falls back to Playwright's Chromium).
Two deliberate allowances: a page whose own document declares `noindex`
(login, search results, the claim flow) has its SEO score computed without
the `is-crawlable` audit, since it can never pass that one and every other
SEO audit still counts; and the 404 page gets axe only, because Lighthouse
refuses to score an error document. In CI the `audit` job runs on
`workflow_dispatch` only, so it never slows a push.

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

### CI/CD: `.github/workflows/deploy.yml`

Coolify is git-connected and builds the image itself; the manual `docker
build` above is for a local check, not what production runs. What triggers
Coolify is `.github/workflows/deploy.yml`, firing automatically once
`.github/workflows/ci.yml` finishes green on `main`, or on demand via the
Actions tab (**Run workflow** on `Deploy`). The manual run re-deploys whatever
Coolify's configured branch — `main` — currently points at, which is the
escape hatch after fixing a secret or a failed smoke test. It **cannot** deploy
another branch: the workflow's `branch` input only picks which ref its own
scripts are checked out from, and Coolify always rebuilds the branch set on
each application. Shipping a hotfix means merging it to `main`. The workflow
never builds anything itself: `scripts/deploy-coolify.sh` calls Coolify's
deploy API for the web app, polls it to `finished`/`failed`, then does the
same for the worker (in that order — migrations run at web boot, and a worker
must not start on a schema the web container hasn't applied; a failed web
deploy leaves the worker untouched). Then `scripts/smoke.sh` waits up to 90 s
for `/api/health` to answer 200 and fails the job if it doesn't report
`db: ok`, if `/`, `/sitemap.xml` or a real listing page pulled out of that
sitemap don't come back 200, or if `/` carries an `X-Robots-Tag: noindex`
header (an image built without `--build-arg SITE_ENV=production`; set
`SMOKE_EXPECT_NOINDEX=1` to smoke a staging site, where the header is
required instead). One deploy runs at a time; a second push queues behind it.

Four **repository secrets** (Settings → Secrets and variables → Actions →
Secrets), never committed anywhere:

| Secret | Where it comes from |
| --- | --- |
| `COOLIFY_BASE` | Your Coolify instance's URL, e.g. `https://coolify.example.com` (no trailing slash needed — the script strips one). |
| `COOLIFY_TOKEN` | Coolify → your user avatar → **Keys & Tokens** → API tokens → create one with deploy permission. Shown once; store it only in this secret. |
| `COOLIFY_WEB_UUID` | The web application's page in Coolify — the UUID in that page's URL (`.../application/<uuid>`). |
| `COOLIFY_WORKER_UUID` | Same, for the worker application. |

Plus one **repository variable** (same settings page, **Variables** tab, not
a secret — it's the site's own public URL): `SITE_URL`, the same value as
`NEXT_PUBLIC_SITE_URL`. `deploy-coolify.sh` never logs `COOLIFY_TOKEN`, only
the `deployment_uuid` Coolify hands back for each app.

A clone with none of these set simply never deploys through this workflow —
push to `main` still runs CI, `deploy.yml`'s gate on `workflow_dispatch ||
(workflow_run success)` still fires, and the job fails at `: "${COOLIFY_BASE:?
COOLIFY_BASE is not set}"` inside `deploy-coolify.sh` rather than doing
anything silently wrong. Set up Coolify manually (§ below) until the four
secrets exist.

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

## Monitoring

Four optional environment variables, none of them ever enforced, all listed as
`OBSERVABILITY_ENV_OPTIONAL` in `config/validate.ts`. A clone with none of them
set boots and serves exactly as it would with all four — a boot that failed over
a missing monitoring URL would be precisely the outage the monitoring was bought
to detect.

| Variable | Read at | Read by |
| --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | **build** | `instrumentation-client.ts` — browser errors |
| `SENTRY_DSN` | boot | `instrumentation.ts` — server errors; falls back to the public DSN |
| `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` | **build** | `app/layout.tsx` — the analytics script's `data-domain` |
| `UPTIME_PUSH_URL` | boot, **worker only** | `worker/index.ts` — the heartbeat push |
| `TRUST_CF_CONNECTING_IP` | optional | runtime | `lib/spam/client-ip.ts` | Set to `true` only when the origin is reachable through Cloudflare alone; then `CF-Connecting-IP` is the client address. Unset: the last `X-Forwarded-For` hop. |

One more optional runtime variable sits outside that list because it is not
monitoring:

| Variable | Read at | Read by |
| --- | --- | --- |
| `INTERNAL_REVALIDATE_SECRET` | boot, **web and worker**, same value | `app/api/internal/revalidate/route.ts` and `lib/revalidate/client.ts` — the worker POSTs the ISR paths a tier change (hourly subscription sync) or backlink boost (backlink check) left stale, and the web container calls `revalidatePath`. Unset, the route 404s and the worker logs once and skips; pages then catch up only when their ISR window turns over. |

The two `NEXT_PUBLIC_` ones are inlined into the client bundle by `next build`.
Setting either at boot does nothing at all; adding Sentry or Plausible to a
running site is a **rebuild**, with `--build-arg`, exactly like `SITE_ENV`.

**Sentry source maps are not uploaded**, so browser stack traces show minified
frames. CI cannot do it: Coolify builds the production image itself from the
Dockerfile, and a `.next` uploaded from the CI runner is a different build
(different chunks, different debug IDs) that no production event would ever
match. `lib/observability/sentry.ts` deliberately does not use
`withSentryConfig` either. Turning this on means doing it where the bytes are
made — a `sentry-cli sourcemaps inject` + `upload` in the Dockerfile `builder`
stage behind `--mount=type=secret,id=sentry_token` (a Coolify build secret),
with `SENTRY_RELEASE` set from Coolify's `SOURCE_COMMIT` at runtime. Not done
yet.

### `GET /api/health`

```json
{"ok":true,"db":"ok","redis":"ok","redisClient":{"status":"ready","downUntil":null},"build":"SioK72al0l6Phr302EJBd","uptimeSeconds":12}
```

`200` when `db` is `ok`, `503` (with `Retry-After: 5`) when it is not. No
authentication — an orchestrator cannot present a credential, and the body is
two up/down flags, the state of this process's Redis handle, a build id already
visible in every `/_next/static/` URL, and a process uptime.

**Redis is reported but does not gate the status.** `cache-handler.mjs` falls
back to a per-process LRU when Redis is unreachable, so the site is slower, not
broken; failing the health check on it would drain every replica at once and
turn a degradation into an outage. Alert on `redis` separately if you care.
`absent` means `REDIS_URL` was never set, which cannot happen in a deployed
container (it is in `RUNTIME_ENV`) but does happen in `next dev`.

**`redis` and `redisClient` answer different questions.** `redis` opens a fresh
connection and asks whether the server is reachable from this container.
`redisClient` is `redisState()` from `lib/redis/client.ts`: the one shared handle
the rate limiter, view counters and badge counters actually go through. Its
`status` is one of `unconfigured` (no `REDIS_URL`, or `next build`),
`disconnected` (nothing open yet; the next call connects), `connecting`, `ready`,
or `down` — the last connect was refused and the handle answers null until the
epoch millisecond in `downUntil` (30 s from the refusal). `redis: "ok"` with
`redisClient.status: "down"` is a real state: the server came back but this
process is still in its cooldown, rate-limiting in memory and buffering counts
until the cooldown ends. Reading the handle's state never connects, so the field
costs nothing; it does not gate `ok` either.

`force-dynamic` and `revalidate = 0` keep the route out of the ISR cache
handler. Without them a health check could be served from Redis — answering
`200` long after the database behind it had gone.

**Coolify:** set the web service's health check path to `/api/health`. The image
carries its own `HEALTHCHECK` on the same endpoint (`node -e` with a global
`fetch`, 30s interval, 60s start period for `MIGRATE_ON_BOOT` migrations), but
Coolify runs its check independently — configure both.

The worker stage declares `HEALTHCHECK NONE`. It inherits `FROM runner` and
serves no HTTP, so an inherited check would mark a perfectly healthy worker
unhealthy forever.

### The worker heartbeat

Every five minutes, on its own `cron.schedule` rather than through the job
`schedule()` helper — that one takes an advisory lock (a second worker's beat
would report "skipped", which is a heartbeat lying about the one thing it
exists to prove) and writes a `job_runs` row per run, inflating the counts the
line reports.

```
[worker] heartbeat queue pending=3 failed=0 done=912 · runs/5m ok=12 failed=0
```

**Its absence is the alert.** The worker listens on no port, so nothing can pull
a check out of it, and a worker that has quietly stopped scheduling looks
exactly like a worker with no work to do.

To alert on that absence, create an **Uptime Kuma push monitor** and set
`UPTIME_PUSH_URL` to its push URL on the worker service only:

```
UPTIME_PUSH_URL=https://uptime.example.com/api/push/<token>
```

Set the monitor's **heartbeat interval to 330 seconds or more** — one beat plus
a margin. Kuma defaults to 60, which alarms between two perfectly healthy beats.

`status=up` and `msg=<the heartbeat line>` are appended unless the URL you
configure already carries them, so the monitor's last message is the queue depth
at the last beat. Any endpoint that answers 200 to a GET works the same way.

The push is **skipped, deliberately, when the job counts cannot be read** — a
worker whose database has gone is still a running process, and pushing "up" from
it would hold the monitor green while no job ever runs. The log line is still
written, with the reason, so `docker logs` explains the silence.

## Operating the site

### The admin console

`/admin` is gated on `profiles.role = 'admin'` and nothing else. A signed-in
user who is not one gets a **404**, not a 403 — confirming the console exists
tells an attacker where to aim. The dashboard shows the queue counts and the
nav; everything on it is waiting on a person.

| Route | Queue | What you do there |
| --- | --- | --- |
| `/admin` | Dashboard | Counts per queue, towns without intro copy |
| `/admin/submissions`, `/admin/submissions/[id]`, `/admin/submissions/page/[n]` | Listings submitted through `/add-listing` | Approve (publishes) or reject with a reason |
| `/admin/claims`, `/admin/claims/[id]` | Ownership claims from `/claim/[listing]` — by verified email link, by outreach token, or by an uploaded document | Decide the claim. A document is fetched through `/api/admin/claims/[id]/document`, and deleted by the worker thirty days after the decision |
| `/admin/reviews` | Reviews left through `/leave-review/[listingId]` and confirmed by email | Publish or reject |
| `/admin/cities` ("Towns") | Every town, and which are published without intro copy | Save intro copy; set published. A town is indexable only on `seo.minListingsToIndex` published listings **and** intro copy |
| `/admin/reports` | Reports from `/report/[id]` | Dismiss, or mark actioned |
| `/admin/removals` | Removal requests from `/remove/[id]` | Mark actioned, or reject |
| `/admin/audit`, `/admin/audit/[entityType]` | The audit log | Read-only |

Owners have `/account`, `/account/listings/[id]`, `…/enquiries`,
`/account/settings` and `/account/billing`. Checkout is
`/checkout/[tier]/[interval]?listing=<id>`, returning via `/checkout/return`.

### Making the first admin

There is no UI for it and there should not be one — `profiles.role` is the
only source of the admin bit, and nothing a client sends can influence it.
Sign up through `/signup`, then promote the account in the database.
Signing up does not create the `profiles` row (`ensureProfile` does, on the
first write), so this inserts it. It is what `e2e/admin.spec.ts` does, in one
statement:

```sql
insert into profiles (user_id, role)
select id, 'admin' from "user" where email = 'you@example.co.uk'
on conflict (user_id) do update set role = 'admin';
```

`role` is `user`, `owner` or `admin`. The same statement with `'owner'` and a
`listings.owner_id = profiles.id` is how a listing is handed to an owner by
hand.

### Billing, start to finish

An owner picks a tier and interval on `/pricing`; `/checkout/[tier]/[interval]`
creates a PayPal subscription against the matching `PAYPAL_PLAN_*` id and sends
them to PayPal to approve. PayPal returns them to `/checkout/return`, which
asks PayPal for the subscription's state directly and applies it through the
same state machine the webhook uses — so the listing shows its new tier while
the buyer is still looking at the page. The `BILLING.SUBSCRIPTION.*` and
`PAYMENT.SALE.COMPLETED` events then arrive at `/api/webhooks/paypal`, are
verified against `PAYPAL_WEBHOOK_ID` (fails closed), and move
`current_period_end` forward on every renewal; the route revalidates the
listing and city pages the tier change touched. The worker sends renewal
reminders 30 and 7 days before, and on, the period end (`renewal-reminders`,
hourly at :17; deduped per subscription and period on `audit_log`). A
cancellation does nothing until the paid period runs out: `subscription-sync`
(hourly at :37) checks every subscription whose period ended more than **three
days** ago against PayPal itself and lapses it to free — or extends it, if a
renewal's webhook never arrived. PayPal unreachable changes nothing in either
direction.

**When webhooks are not landing.** `PAYPAL_WEBHOOK_ID` unset with
`PAYPAL_CLIENT_ID` set refuses to boot, so the silent failure is a *wrong* id
or a webhook registered against the wrong URL or events: every delivery is
answered 401, nothing is written, and the application looks healthy while
`current_period_end` stops moving. Symptom: paying customers dropping to free
three days after each renewal, with the hourly sync putting them back.
Fix: in the PayPal dashboard register (or re-check) a webhook at
`https://<domain>/api/webhooks/paypal` subscribed to `BILLING.SUBSCRIPTION.*`
and `PAYMENT.SALE.COMPLETED`, paste its id into `PAYPAL_WEBHOOK_ID` on **both**
services, restart. The next `subscription-sync` tick reconciles whatever was
missed; nothing needs replaying by hand. `scripts/paypal-setup.ts` prints this
reminder because it deliberately does not create the webhook.

### Testing gotchas

`corepack pnpm test:e2e -- e2e/admin.spec.ts` does **not** run one file — the
`--` is swallowed and the whole suite runs. The per-file form is
`corepack pnpm exec playwright test e2e/admin.spec.ts`.

Redis has **16 databases**, `0` to `15`. `redis://localhost:6380/16` is not a
spare index, it is a connection error — and each worktree's e2e run wants its
own index (or its own `CACHE_NAMESPACE`) so their caches and rate-limit
counters do not collide. `redis-cli -n <db> FLUSHDB` clears one.

## Worker jobs

`worker/index.ts` schedules everything with node-cron inside the worker
container: no system cron, no HTTP endpoints. Every job except the heartbeat
runs under a Postgres advisory lock named after the job — a second worker
reports `skipped (lock held elsewhere)` — inside one transaction, and writes a
`job_runs` row (`ok` / `failed` with the error) that the heartbeat counts. A job may hand back ISR paths its writes left stale; they are
POSTed to the web container **after** the lock's transaction commits (see
`INTERNAL_REVALIDATE_SECRET`).

The container's health check is a liveness file (`/tmp/worker-alive`,
`lib/boot/liveness.ts`) the worker touches at boot and on every heartbeat;
stale for fifteen minutes means unhealthy. Coolify needs a check that can
report "healthy" — `HEALTHCHECK NONE` made every worker deploy fail.

| Job | Schedule | What it does | Needs beyond the required set |
| --- | --- | --- | --- |
| `derivatives` | every minute | Produces the four WebP sizes for originals with none, capped attempts per image | `R2_*`, `R2_BUCKET_MEDIA` |
| `notify` | every **30 s** | Drains `job_queue` notifications into email: enquiries, submissions, claims, reviews, removals, auth mail | `RESEND_API_KEY`, `EMAIL_FROM`; `ADMIN_NOTIFICATION_EMAIL` for the admin copies |
| heartbeat | every 5 min | Logs queue and run counts; GETs the push monitor. No lock, no `job_runs` row, on purpose | `UPTIME_PUSH_URL` (optional) |
| `flush-stats` | every 5 min | Folds the Redis view counters into `listing_stats_daily` | — |
| `purge-claim-docs` | daily 03:00 | Deletes claim documents thirty days after the claim was decided | `R2_*`, `R2_BUCKET_CLAIM_DOCS` (skips when unset) |
| `purge-jobs` | daily 03:30 | Deletes `job_queue` rows that finished (done or failed) more than seven days ago; the tokens they carried were already scrubbed on completion | — |
| `backlink-check` | hourly :00 | Re-fetches badge backlinks — weekly for a verified one, daily for one never seen working — and grants or withdraws the `+5 rank_boost`; returns the pages to revalidate | `INTERNAL_REVALIDATE_SECRET` (optional) |
| `badge-counters` | every minute | Moves badge impressions and clicks from Redis into `badges` | — |
| `renewal-reminders` | hourly :17 | Queues the 30-, 7- and 0-day renewal emails, once per subscription and period | `PAYPAL_*` (no-op otherwise), the email vars for delivery |
| `subscription-sync` | hourly :37 | Reconciles subscriptions whose paid period ended over three days ago against PayPal; lapses or extends; returns the pages to revalidate | `PAYPAL_*` (logs "not configured" otherwise), `INTERNAL_REVALIDATE_SECRET` (optional) |
| `purge-stats` | daily 04:00 | Deletes `listing_stats_daily` rows older than `siteConfig.stats.retentionDays` (400; the build refuses less than 30 or less than any tier's `statsWindowDays`). `listings.view_count`, the lifetime total the flush maintains, is untouched | — |

Every job is a no-op on a site without the feature it serves; none of them
fails the worker. What fails the worker is a missing required variable at
boot (`validateEnv`, same list as the web container plus the billing group
when `PAYPAL_CLIENT_ID` is set) — it exits 1 rather than sit "up" running
nothing.

## Scripts

Everything under `scripts/`, what it needs and when to reach for it.
`scripts/seed.ts` and `scripts/seed-cli.ts` are covered under Seeding above.

**`scripts/paypal-setup.ts`** — `corepack pnpm tsx scripts/paypal-setup.ts`.
Creates the PayPal product and one plan per billable tier and interval from
`config/site.config.ts`, then prints the `PAYPAL_PLAN_*` lines to paste into
the environment. Needs `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`;
`PAYPAL_ENV=live` for the real account, sandbox otherwise, and it says which at
the top. Idempotent by **name**: a re-run reuses existing plans and prints the
same ids. It never edits a plan's price — a price change is a new plan name
(`planNameFor`) and a migration of the people on the old one. Run it once per
PayPal account before turning billing on, and again after adding a tier. It
does not create the webhook; that is a dashboard step (see Billing above).

**`scripts/outreach-batch.ts`** —
`tsx scripts/outreach-batch.ts --segment city=leeds --limit 50 --coupon-percent 50`.
Builds one claim-outreach campaign: a campaign row, a message per unclaimed
listing in the segment and a single-use coupon per recipient, in **one
transaction**, and writes the CSV (stdout, or `--out FILE`; the summary goes to
stderr so a pipe stays clean). `--segment` takes `city=<slug>` and/or
`category=<slug>`, repeatable; `--name` names the campaign; `--actor UUID`
records who ran it on the audit row and every coupon; `--dry-run` builds and
prints it, then rolls the whole thing back. Needs `DATABASE_URL`. Run it when
you are about to mail a batch of unclaimed listings, and read the CSV with
`--dry-run` first.

**`scripts/e2e-db.sh`** — `corepack pnpm test:e2e:db` (`--reset` to drop and
rebuild). Creates `directory_e2e` if missing, migrates and seeds it, using
`psql` inside the compose container so no local client is needed. Refuses to
touch `directory_dev` or `directory_test` whatever `DB_NAME` says. Optional
overrides: `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT` (5433),
`POSTGRES_CONTAINER`. Run it before a Playwright run; `--reset` after the seed
CSVs change or a failed run left rows behind.

**`scripts/deploy-coolify.sh`** —
`COOLIFY_BASE=… COOLIFY_TOKEN=… scripts/deploy-coolify.sh web:<uuid> worker:<uuid>`.
Triggers a Coolify deployment per argument, in order, and polls each to
`finished` before starting the next; the first failure or timeout stops it
with a non-zero exit. Put the app that migrates (web) first. Needs
`COOLIFY_BASE`, `COOLIFY_TOKEN`, `jq` and `curl`; `POLL_INTERVAL_SECONDS` (5)
and `POLL_TIMEOUT_SECONDS` (600, per app) tune the polling. Called by
`.github/workflows/deploy.yml`; run it by hand when the workflow's secrets are
not set up yet.

**`scripts/smoke.sh`** — `scripts/smoke.sh https://example.co.uk`. Post-deploy
check: waits up to ~90 s for `/api/health` to answer 200 with `db: "ok"`, then
requires `/` 200 without `X-Robots-Tag: noindex`, `/sitemap.xml` 200
advertising a listing shard on the same host, and a real listing page read out
of that shard to 200. `SMOKE_EXPECT_NOINDEX=1` inverts the header check for a
staging site; `SMOKE_WARMUP_ATTEMPTS` (18) and `SMOKE_WARMUP_INTERVAL_SECONDS`
(5) set the wait. Needs `curl` and `jq`, no app secrets. The deploy workflow
runs it; run it by hand after any manual deploy.

**`scripts/verify-image.sh`** — `./scripts/verify-image.sh`. Builds the image
and proves the things a build cannot: the cache handler imports, the entrypoint
retains `.next/static` across two starts and refuses a read-only volume, the
worker image starts `worker/index.ts` under tsx, `scripts/migrate.mjs` runs
inside the prod-only runner, the worker can seed what the runner migrated,
`SITE_ENV` really is a build arg, and `MIGRATE_ON_BOOT=true` migrates before
serving. Needs Docker, the dev Postgres and Redis from `pnpm db:up`
(`DEV_DATABASE_URL`, `RUNTIME_REDIS_URL` override them; it uses Redis database
5 to stay clear of dev work), and `IMAGE` to name the tag. Run it after any
change to the Dockerfile, the entrypoint, `cache-handler.mjs` or `migrate.mjs`.

**`scripts/purge-cache.sh`** — `REDIS_URL="$REDIS_URL" ./scripts/purge-cache.sh`.
Deletes every ISR namespace under `CACHE_NAMESPACE` (default `nextjs`) except
the running build's, read from `.next/BUILD_ID`. `KEEP_BUILD_ID=<id>` keeps a
different one, `KEEP_BUILD_ID=none` purges everything — the way to force every
page to re-render now — and `DRY_RUN=1` lists without deleting. Needs
`redis-cli` on the host and a checkout; it cannot run inside the runner image.
Normally never needed: the app sweeps stale namespaces itself a minute after
boot. Reach for it to force a full re-render, or to clean a Redis that
predates the namespacing.

**`scripts/reseed-dev.sh`** — `bash scripts/reseed-dev.sh`. **Destructive.**
Drops and recreates `directory_dev`, migrates it and re-seeds from `seeds/`.
Same `DB_*` / `POSTGRES_CONTAINER` overrides as `e2e-db.sh`; refuses
`directory_test`. Run it after changing the seed CSVs — the seed is idempotent,
so `pnpm seed` on an existing database would keep the old rows.

**`scripts/check-niche-strings.sh`** — `corepack pnpm check:strings`. Greps
`app`, `components`, `lib`, `worker`, `scripts` and `content` (`.ts`, `.tsx`,
`.md`, `.mdx`, `.sh`, `.mjs`; tests and `content/blog/demo/` exempt) for the
banned niche words and fails if any literal survives once `siteConfig.*`
references are stripped. `docs/` and this README are not scanned. No env. CI
runs it; run it before committing copy, and regenerate `BANNED` for a clone.

**`scripts/migrate.mjs`** — `DATABASE_URL=… node scripts/migrate.mjs`. The
production migration runner: plain ESM over the same `drizzle/` folder and the
same `migrate()` as `drizzle-kit`, so it runs in the prod-only runner image
where `drizzle-kit` does not exist. Idempotent (`already up to date`); exits 1
with a message when `DATABASE_URL` is unset or unreachable. `MIGRATE_ON_BOOT`
runs it at web boot; run it by hand for a one-off migration against a database
you are inspecting.

**`scripts/new-site.ts`** — `corepack pnpm new-site` (`--answers file.json`,
`--dry-run`, `--target`, `--site-env`, `--keep-demo`, `--allow-placeholders`,
`--overwrite`). The clone wizard: writes `config/site.config.ts`, the seed
CSVs and a `.env` from your answers, after running the same validators as the
build. No env; an existing `.env` is never touched. Run it once per clone —
`docs/CLONING.md` is the walkthrough.

## Layout

```
config/          site.config.ts — the only file a clone edits
lib/routing/     slug registry, slugify, PillarScope, resolver
lib/db/          Drizzle schema (40 tables) and queries
lib/features/    build-time flags, route guard, single navigation source
seeds/<plural>/  cities, categories and listings CSVs, named after the entity
scripts/         seed, migrate, paypal-setup, outreach, deploy, smoke, cache purge — see Scripts
content/blog/    posts; content/blog/demo/ loads only in demo mode
e2e/             Playwright specs, run against the standalone build
test/            rollback-per-test harness
docs/            spikes and implementation plans
```

Two things a clone touches beyond `site.config.ts`: rename `seeds/venues/` to
match the new `entity.plural` and replace the three CSVs inside it, and
regenerate the banned-word list in `scripts/check-niche-strings.sh` so the new
site bans its own niche words rather than the old site's.
