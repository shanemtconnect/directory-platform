# Cloning this platform into a new directory

Target: a new directory site, configured, seeded and deployed, in under four
hours. The wizard does the mechanical part in about ten minutes; the rest is
you deciding what the site is, getting credentials, and writing the town intro
copy that lets pages be indexed at all.

```bash
corepack pnpm install
corepack pnpm new-site
```

Everything the wizard writes is a pure function of your answers, so save the
answers file and a re-run reproduces the same site byte for byte.

---

## 1. Run the wizard (10 minutes)

```bash
corepack pnpm new-site                          # interactive
corepack pnpm new-site --answers answers.json   # replay a saved run
corepack pnpm new-site --answers answers.json --dry-run
```

| Flag                   | What it does                                                    |
| ---------------------- | --------------------------------------------------------------- |
| `--answers <file>`     | Answer from JSON instead of a terminal. Keys are question keys.  |
| `--dry-run`            | Print the config it would write. Writes nothing.                 |
| `--target <dir>`       | Write into another checkout. Defaults to the current directory.  |
| `--site-env <value>`   | `SITE_ENV` for the generated `.env`. Default `staging`.          |
| `--keep-demo`          | Keep the template's demo blog posts.                             |
| `--allow-placeholders` | Accept `legalEntity: "TBC"`. A production build will not.        |
| `--overwrite`          | Replace an existing config and seed CSVs.                        |

It writes three things and nothing else:

- `config/site.config.ts` — the only file a clone edits.
- `seeds/<niche>/{cities,categories,listings}.csv`
- `.env`, copied from `.env.example` with the values your answers already
  determine (`NEXT_PUBLIC_SITE_URL`, `BETTER_AUTH_URL`, `SITE_ENV`) filled in.
  An existing `.env` is never touched — those hold live secrets.

Nothing is written until every answer has passed the same validators the build
runs (`validateFeatureDependencies`, `validateCountry`). A config that would
fail `next build` never reaches disk.

### What it asks

| Group      | Questions                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------- |
| Identity   | site name, short name, domain, tagline, legal entity, support email                              |
| Nouns      | singular, plural, both capitalised, the verb an owner does, what you call an owner                |
| Market     | country (GB/US/AU/CA), then locale, currency, timezone and region label default from its profile |
| Shape      | `niche-national` or `local-multi-vertical`                                                        |
| Markup     | schema.org type for a listing and for the site; whether `priceRange` is emitted                   |
| Theme      | primary and accent colour, heading and body font, corner radius                                   |
| Listings   | description cap, custom fields (repeatable), review criteria                                      |
| Pricing    | monthly and annual price per paid tier, trial length, image caps                                  |
| Features   | one question per feature flag, each with a one-line description                                   |
| SEO        | listings a town needs before indexing, whether intro copy is also required, footer link cap       |
| Seed data  | `csv` (your files), `template` (three example rows to edit) or `skip`                             |

**The nouns are the whole game.** Every visible string comes from
`siteConfig.entity`; no component contains a niche word, and
`corepack pnpm check:strings` fails the build if one appears. Get the singular
and plural right and the site reads correctly everywhere.

**Annual = 10 × monthly** is offered as the default annual price. That makes
"save two months" literally true. Change it and the pricing copy starts lying.

**Custom fields** are repeatable, one per line:

```
key|Label|type[|searchable][|showInCard][|options=a;b][|free|essential|premium]
room_count|Rooms|number|searchable|showInCard
price_from|Prices from|currency|essential
```

Types are `number`, `boolean`, `text`, `select`, `currency`. A trailing tier
name gates the field to that tier and above. Contact details — name, address,
phone, opening hours, map pin, category, the enquiry form and the reviews — are
never gated on any tier, so never put one behind one.

---

## 2. Seed data (30 minutes, or a day if you are sourcing it)

`seeds/<niche>/` holds three CSVs. `scripts/seed.ts` reads exactly these
columns; anything else is ignored.

**cities.csv** — required: `name`

```csv
name,region,country,lat,lng,population
Leeds,West Yorkshire,GB,53.8008,-1.5491,536280
```

**categories.csv** — required: `name`

```csv
name,singular,plural,sort_order
Rehearsal Rooms,rehearsal room,rehearsal rooms,0
```

**listings.csv** — required: `name`, `city`, `category`

```csv
name,city,category,address_line1,postcode,phone,website
Northgate Rooms,Leeds,Rehearsal Rooms,12 Northgate,LS1 4DY,01632 960000,https://example.com/northgate
```

`city` and `category` must match a `name` in the other two files exactly, or
the row is skipped. Values must not contain commas or quotes — the seed parser
is deliberately naive; the CSV importer in `lib/import/` is the one that
handles third-party files.

Seeding is idempotent: re-running adds nothing and changes nothing. Seeded
listings carry no rating, no review, and `claim_status = 'unclaimed'`.

```bash
corepack pnpm db:up
DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev \
  corepack pnpm db:migrate
DATABASE_URL=... corepack pnpm seed <niche>
corepack pnpm dev
```

If you chose `template`, the three example rows are placeholders built from
your nouns. Latitude and longitude are blank on purpose — the map needs real
coordinates and a plausible wrong one is worse than an obvious gap.

---

## 3. Environment variables, by phase

**Build** — needed to produce the image, and baked into it. `NEXT_PUBLIC_*`
values are inlined at build time, so a wrong one cannot be fixed at boot.

| Variable                    | Note                                                     |
| --------------------------- | -------------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL`      | Canonicals, sitemap, JSON-LD. The only one `validateEnv` requires at build. |
| `NEXT_PUBLIC_MAPTILER_KEY`  | Omit it and the map silently renders nothing, in production too. |
| `NEXT_PUBLIC_MEDIA_URL`     | CDN origin for images.                                    |

**Runtime** — injected per site at boot. `validateEnv(env, { phase: "runtime" })`
refuses to start without any of them, which is the point: a site that boots
without its payment config is worse than one that refuses to.

`DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_MEDIA`,
`R2_BUCKET_CLAIM_DOCS`, `NEXT_PUBLIC_MEDIA_URL`, `PAYPAL_CLIENT_ID`,
`PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `RESEND_API_KEY`, `EMAIL_FROM`,
`ADMIN_NOTIFICATION_EMAIL`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
`MAPTILER_KEY`, `NEXT_PUBLIC_MAPTILER_KEY`.

`PAYPAL_WEBHOOK_ID` unset does not fail loudly at the point it matters — it
stops renewals silently. Set it before you take a payment.

**Worker** — the same image, different entrypoint. Set `WORKER_ENABLED=true` on
that container only.

**Optional** — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GEOCODING_API_KEY`,
`SENTRY_DSN`.

**`SITE_ENV`** — anything other than `production` forces `noindex` site-wide.
The wizard writes `staging`. Leave it there until the content is real.

---

## 4. Deploy on Coolify (30 minutes)

1. **New application** → the site's Git repo, branch `main`.
2. **Build:** the repo has a `Dockerfile` with a `runner` and a `worker` stage.
   Set the build arguments `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_MAPTILER_KEY`
   — they are inlined at build time and cannot be corrected later.
3. **Environment:** paste the runtime list above. Coolify's own variables do not
   reach the build stage unless you also declare them as build args.
4. **Persistent volume** for the static asset directory. Mount a volume and
   point `STATIC_ASSETS_DIR` at it, otherwise generated assets live in the
   container filesystem and every redeploy throws them away.
   *(`STATIC_ASSETS_DIR` is read by the media layer; add it to `.env.example`
   when that lands, and set it here in the meantime.)*
5. **Pre-deploy command:** `corepack pnpm db:migrate`. Coolify runs it against
   the new image before switching traffic, so a migration failure aborts the
   deploy instead of half-applying it. Never run migrations from the app
   container's start command — every replica would race.
6. **Second application** from the same repo for the worker: Dockerfile target
   `worker`, `WORKER_ENABLED=true`, no domain, no health check on a port.
7. **Redis** must be reachable at `REDIS_URL`. The ISR cache handler is
   Redis-backed and guards against connecting during `next build`; without the
   guard the build hangs silently, and without Redis each replica keeps its own
   in-process LRU that dies with the container.
8. **No post-deployment command is needed for the cache.** Keys are namespaced
   `nextjs:<buildId>:` so a deploy starts cold rather than serving the previous
   build's HTML, and nothing expires the namespace the previous build left
   behind — so the app sweeps it itself, a minute after the new container
   connects to Redis (`CACHE_SWEEP_DELAY_MS`, default `60000`; the delay lets a
   rolling deploy finish before the old replica's cache is deleted).
   `scripts/purge-cache.sh` does the same thing by hand from a host with a
   `redis-cli`; it cannot run as a post-deployment command inside the runner
   container, which ships the standalone server and nothing else.

---

## 5. DNS

1. Point the apex and `www` at the Coolify host (A/AAAA, or CNAME for `www`).
2. Set the domain in Coolify so it requests the certificate; wait for it.
3. Decide apex or `www` and 301 the other. `NEXT_PUBLIC_SITE_URL` must be the
   one you keep — canonicals are generated from it, and disagreeing with the
   redirect is how a site ends up with two of every page.
4. Only then set `SITE_ENV=production` and submit the sitemap.

---

## 6. The indexing gate

A town page is `noindex` until it has **both**:

- at least `seo.minListingsToIndex` published listings, and
- real intro copy (`intro_html IS NOT NULL`), when
  `seo.requireIntroCopyToIndex` is on.

This is not a setting to relax on launch day. Thin town pages are the specific
way a directory sinks its own domain, and a site that launches with 200
one-listing towns takes months to recover. Seed the towns, write the copy for
the ones that matter, and let the rest earn it.

Every slug change writes a `redirects` row and serves a 301. Never break a URL.

---

## 7. Legal checklist

- [ ] **`legalEntity`** is the registered company or sole trader, exactly as
      registered. `TBC` is refused by a production build; the wizard only lets
      it through with `--allow-placeholders`.
- [ ] **Terms** reviewed for this site: what a paid listing buys, the renewal
      and cancellation terms, and the trial. Prices on the page come from
      `siteConfig.tiers`; the terms must not contradict them.
- [ ] **Privacy notice** reviewed: what you collect from visitors and from
      owners, the legal basis, the retention period, and how someone gets their
      data removed. Name the processors you actually use.
- [ ] **Data sources page** — say where the listing data came from. A directory
      that seeded itself from a public register should say so, and honour
      removal requests against the normalised postcode, not the typed one.
- [ ] **Never fabricate `aggregateRating` or `review`.** Markup must match what
      is rendered. If it is not on the page it is not in the JSON-LD.
- [ ] **Claiming:** a paid subscription alone never grants the verified badge.
      The owner must also clear the control check.
- [ ] Cookie/consent banner if you add anything beyond strictly necessary
      cookies.

---

## 8. Verify before you announce

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm check:strings     # no niche word left in a component
corepack pnpm build:flags-off   # the site builds with every feature off
corepack pnpm build:flags-on    # and with every feature on
```

`check:strings` derives its banned list from the current niche. Regenerate it
for the new site — a plumber directory should ban "plumber", not the word the
template happened to ship with.
