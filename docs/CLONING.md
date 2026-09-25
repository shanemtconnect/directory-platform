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

A fresh checkout carries the demo niche's `config/site.config.ts`; the wizard
recognises it as the template and replaces it without `--overwrite`. The flag
is only for replacing a config the wizard itself wrote earlier.

### `--answers`

The answers file is a JSON object keyed by question key — one key per row of
the table below, every key optional, a missing one taking the question's
default. [`docs/examples/answers.example.json`](examples/answers.example.json)
is a complete one: a US dog-groomer directory, every question answered, with
its seed CSVs beside it in `docs/examples/seeds/`. Copy it, change the values,
and keep it in the repo: it is the whole input, so the site is reproducible
from it, and it is what `scripts/verify-clone.sh` runs.

```bash
cp docs/examples/answers.example.json answers.json
$EDITOR answers.json
corepack pnpm new-site --answers answers.json --dry-run   # look first
corepack pnpm new-site --answers answers.json
```

Value types follow the question: strings for text and choices, numbers for
prices and caps (`null` for an unlimited image cap), booleans for the feature
flags and yes/no questions, and arrays of objects for the two lists —
`customFields` items are `{ key, label, type, options?, searchable?,
showInCard?, tier? }` and `reviewCriteria` items are `{ key, label }`. A
string given for a number or boolean is coerced the way a typed answer would
be. The three `seed*Csv` paths are read relative to the directory you run the
wizard from and are only asked when `seedSource` is `csv`; a key for a
question that is not asked, or a key the wizard does not know, is reported as
an error along with every other problem in the file, so one run shows you all
of them.

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

`savedSearches` (off by default, no dependency) lets a signed-in visitor save a
search on `/search` — and on `/jobs` when `jobBoard` is also on — and get a
daily or weekly email of new matches, managed at `/account/alerts`. It needs
the worker running (the hourly `alerts.dispatch` job) and email configured.

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

**Pay-per-lead** (`leadMarketplace`, needs `quoteBroadcast`) is off by
default. With it on, every get-quotes request is held until the requester
confirms it from a verification link (48 hours, then it expires); a verified request
that reached no paying local listing, a lead-capture box on the home page or a
rail, or a confirmed enquiry to an unclaimed listing with no email becomes a
lead. The privacy line on every form then reads from `lib/leads/consent.ts`. The
wizard writes the defaults into `leads` in `config/site.config.ts` — `floor`
(what a lead sells for, in the site currency; at least 1), `packs` (credit
top-ups, ascending), `halfPriceAfterDays`, `deleteAfterDays`,
`refundWindowDays`, `retainSoldDays` (how long a sold lead's contact details
are kept after the sale; 90 by default) — and the build refuses a floor below
1, packs out of order, or a `retainSoldDays` shorter than `refundWindowDays`. Price your market there, never in a page.

Buyers see leads at `/leads` (signed-in only) and set up **standing orders**
at `/account/leads` — towns, regions or everywhere, categories, and a price
of at least the floor — which buy each new lead the moment it is confirmed,
highest price first. A lead nobody's order takes stays on the board and
halves in price after `halfPriceAfterDays`. Refunds are credit only, for the
six reasons printed on the board, within `refundWindowDays`, approved at
`/admin/leads`; an approval for a dead phone, wrong person, spam or "never
asked" also blocklists the lead's phone and email for a year.
The no-refund wording lives in `lib/leads/market.ts` — edit it there if your
market's norms differ. Nothing else in the lead market needs configuring.

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
name,city,region,category,address_line1,postcode,phone,website
Northgate Rooms,Leeds,West Yorkshire,Rehearsal Rooms,12 Northgate,LS1 4DY,01632 960000,https://example.com/northgate
```

`city` and `category` must match a `name` in the other two files exactly, or
the row is skipped — and `region` must match the city's `region` too, because
that pair is how the loader tells two Richmonds apart. A city with no region in
`cities.csv` takes a blank `region` here. Values must not contain commas or quotes — the seed parser
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

**Required to boot** — injected per site. `validateEnv(env, { phase: "runtime" })`
refuses to start without any of these five (`RUNTIME_ENV` in
`config/validate.ts`), which is the point: a site that boots half-configured is
worse than one that refuses to.

`NEXT_PUBLIC_SITE_URL`, `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`,
`BETTER_AUTH_URL`.

The list is deliberately short — only variables something actually reads today.
`BETTER_AUTH_SECRET` is here because a secret that changes between boots signs
session cookies the next boot cannot verify, and `BETTER_AUTH_URL` because the
callbacks otherwise point at the wrong origin: both are quietly broken logins
rather than visible failures.

**Required once billing is on** — `PAYPAL_CLIENT_ID` is the switch. Leave it
blank and the site runs free listings only. Set it and `PAYPAL_CLIENT_SECRET`,
`PAYPAL_WEBHOOK_ID` and one `PAYPAL_PLAN_<TIER>_<INTERVAL>` per paid tier and
interval (`PAYPAL_PLAN_ESSENTIAL_MONTHLY`, `…_ESSENTIAL_ANNUAL`,
`…_PREMIUM_MONTHLY`, `…_PREMIUM_ANNUAL` for the shipped tiers) become required
on both services (`BILLING_ENV` in `config/validate.ts`). `PAYPAL_ENV` stays
optional: sandbox unless it is the literal `live`. §3b walks through getting
each value.

**Wired but never a boot requirement** — listed as `RUNTIME_ENV_PHASE5` in
`config/validate.ts`: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET_MEDIA`, `R2_BUCKET_CLAIM_DOCS` (images and
claim documents) · `RESEND_API_KEY`, `EMAIL_FROM`, `ADMIN_NOTIFICATION_EMAIL`
(transactional email). A site without them boots, still takes enquiries, and
logs one warning for the mail it is not sending.

A `PAYPAL_WEBHOOK_ID` that is *wrong* — or a webhook registered against the
wrong URL or events — does not fail loudly at the point it matters: every
delivery is rejected and renewals stop until the hourly sync catches them,
three days late. Check it against a sandbox purchase before you take a
payment (README → Operating the site).

The README's [Environment variables](../README.md#environment-variables)
table lists every variable the code reads, which module reads it, and what
each one costs when unset.

**Never a boot requirement** — `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
`MAPTILER_KEY`. Both features degrade rather than break. But note that
Turnstile fails **closed** whenever `NODE_ENV=production`, which staging also
is: a staging site with no `TURNSTILE_SECRET_KEY` rejects every enquiry. Use
Cloudflare's published always-pass testing keys there
(`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`).

`NEXT_PUBLIC_MEDIA_URL` and `NEXT_PUBLIC_MAPTILER_KEY` are **build** args, listed
above — setting them at boot does nothing.

**Worker** — the same image, different entrypoint. Set `WORKER_ENABLED=true` on
that container only.

**Optional** — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GEOCODING_API_KEY`.

**Optional, but set it** — `INTERNAL_REVALIDATE_SECRET`, the same random value
on the web service AND the worker. The worker cannot touch the web container's
ISR cache directly, so when the hourly subscription sync lands a tier change
(an expiry, or a renewal whose webhook was missed) or the backlink check grants
or withdraws a boost, it POSTs the affected paths to
`/api/internal/revalidate` with this as a bearer token. Without it the route
404s, the worker logs once and skips, and a lapsed listing keeps its paid tier
on the cached page until the ISR window turns over. Generate it like
`BETTER_AUTH_SECRET` (`openssl rand -hex 32`).

**Monitoring** — all four optional, none ever enforced, listed together as
`OBSERVABILITY_ENV_OPTIONAL` in `config/validate.ts`. A site with none of them
set boots, serves and reports nothing, which is the right default for a clone
that has not bought an error tracker yet.

| Variable | When | Note |
| --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | **build** | Browser errors. Inlined into the client bundle — setting it at boot does nothing. |
| `SENTRY_DSN` | boot | Server errors. Falls back to the public DSN above, so one DSN in one variable covers both. |
| `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` | **build** | The bare hostname registered in Plausible (`example.co.uk`), never a URL. Unset ⇒ no analytics script at all. |
| `UPTIME_PUSH_URL` | boot, **worker only** | An Uptime Kuma push monitor URL. The worker GETs it every five minutes. |

Plausible sets no cookies and stores no personal data, so it needs **no consent
banner** and no entry in the privacy policy's cookie table. That is the reason
it is the analytics script here. Anything you replace it with that does set a
cookie needs a consent gate built in front of it first, and a privacy policy
change — do not swap it casually.

Sentry runs with `sendDefaultPii: false` and `tracesSampleRate: 0.1`. PII
scrubbing is not optional: enquiry form bodies carry a member of the public's
name, email address and message, and the privacy policy does not say those go
to a third-party error tracker.

**`SITE_ENV`** — **a build arg, not a runtime variable.** Only the literal
`production` is production; anything else — `staging`, a typo, an empty value,
an unset variable — forces `noindex` site-wide. Indexing is opted into, because
a production site that forgets the variable serves `noindex` for a day while a
staging site that forgets it gets its whole duplicate directory indexed for
months. The wizard writes `staging`. Leave it there until the content is real.

Two things read it, and only one of them can be changed at boot:

| Mechanism | Where it comes from | Follows a boot value? |
| --- | --- | --- |
| `X-Robots-Tag: noindex` on every response | `next.config.ts` `headers()`, evaluated by `next build` and frozen into `.next/routes-manifest.json` | **No** |
| `robots.txt`, and whether the sitemap has any URLs | `app/robots.ts` / `app/sitemaps/`, `force-dynamic`, read per request | Yes |

So **flipping staging → production is a rebuild**, with
`--build-arg SITE_ENV=production`. Changing only the container's environment
gives the worst state available: `robots.txt` says `Allow: /` while every
response still carries `X-Robots-Tag: noindex`, and nothing in the logs says so.
`scripts/verify-image.sh` builds both ways to keep the arg wired.

---

## 3b. Third-party services (45 minutes, mostly waiting on DNS)

Each of these is optional in the sense that the site boots without it. None
is optional for a site that is taking claims, enquiries or money. Do them in
this order — the DNS ones first, so the verification has propagated by the
time you need it.

**Secrets.** Generate every one the same way and never reuse one across sites:

```bash
openssl rand -hex 32     # BETTER_AUTH_SECRET
openssl rand -hex 32     # INTERNAL_REVALIDATE_SECRET — same value on web AND worker
```

`INTERNAL_REVALIDATE_SECRET` is how the worker tells the web container which
ISR pages a tier lapse or a badge boost left stale. Set it on both services
or nothing is revalidated; set it on one and the other silently disagrees.

**Resend (transactional email).** Add the site's domain in Resend, publish the
DKIM and SPF records it gives you, and wait for **Verified**. Then set
`RESEND_API_KEY`, `EMAIL_FROM` (an address on that verified domain — a sender
elsewhere is rejected) and `ADMIN_NOTIFICATION_EMAIL` (where new submissions,
claims, reports and enquiries are copied to). Until all three are set the
worker warns once and drops the mail; enquiries are still saved, so nothing
looks wrong. Verified-email claims and review confirmations depend on this
going out.

**Cloudflare R2 (images and claim documents).** Two buckets: one for listing
media (`R2_BUCKET_MEDIA`, behind a public CDN hostname that becomes the
`NEXT_PUBLIC_MEDIA_URL` build arg) and a private one for claim documents
(`R2_BUCKET_CLAIM_DOCS`), which are utility bills and the like and must never
be public. One API token with object read/write on both gives
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. **The claim-docs
bucket needs a CORS rule**: the browser POSTs the file straight to the bucket
with a presigned form (`components/claim/DocumentClaimForm.tsx`), so allow
origin `NEXT_PUBLIC_SITE_URL`, method `POST`, and the `Content-Type` header;
without it every document upload fails in the browser and the server sees
nothing. With `R2_BUCKET_CLAIM_DOCS` unset the document route is simply not
offered and owners can only claim by email. The worker deletes documents thirty
days after a decision (`purge-claim-docs`) — the privacy notice promises it.

**Cloudflare Turnstile (forms).** Create a widget for the site's hostname —
add the staging hostname too, or use the always-pass test keys there
(§3) — and set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. Remember
that production **fails closed**: a production build with no secret key
rejects every listing submission, review, report and removal request.

**PayPal (billing).** Only when the site is ready to charge; a directory can
run for months on free listings first, and the boot does not ask for any of
this until `PAYPAL_CLIENT_ID` is set.

1. Create a REST app in the PayPal developer dashboard — sandbox first — and
   note the client id and secret.
2. Create the plans from the tiers in `config/site.config.ts`:

   ```bash
   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… corepack pnpm tsx scripts/paypal-setup.ts
   ```

   It creates one product and one plan per paid tier and interval, reuses
   anything already there by name, and prints the `PAYPAL_PLAN_*` lines to
   paste into the environment. `PAYPAL_ENV=live` runs it against the live
   account; run it once per account.
3. In the dashboard add a **webhook** at
   `https://<domain>/api/webhooks/paypal` subscribed to
   `BILLING.SUBSCRIPTION.*` and `PAYMENT.SALE.COMPLETED`, and put its id in
   `PAYPAL_WEBHOOK_ID`. The script does not do this for you and says so.
4. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, the
   four `PAYPAL_PLAN_*` ids and `PAYPAL_ENV` on **both** the web and the
   worker service. From this point a missing one refuses to boot.
5. Buy a plan in the sandbox and watch `/account/billing` and the webhook
   route's log line before switching `PAYPAL_ENV=live` with the live app's
   credentials and a live webhook.

Changing a price later is a **new plan**, not an edit — the script matches by
name and never touches an existing plan's price. Rename via `planNameFor`,
re-run, swap the id.

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
   *(`STATIC_ASSETS_DIR` is read by `docker-entrypoint.sh`, web role only;
   a mount it cannot write to refuses to boot rather than serve dead assets.)*
5. **Environment:** set `MIGRATE_ON_BOOT=true` on this (web) service. Coolify's
   pre-deployment command runs inside the *previous* running container, so it
   never runs on a first deploy and on later deploys it would run the OLD
   image's migrator against the NEW schema; `docker-entrypoint.sh` runs
   `scripts/migrate.mjs` in the new container itself, before it serves any
   traffic, and a migration failure aborts boot instead of half-applying it.

   For a manual or one-off migration, run the same script directly:
   `node scripts/migrate.mjs`. **Not `corepack pnpm db:migrate`.** That is
   `drizzle-kit migrate`, and `drizzle-kit` is a devDependency the prod-only
   runner tree does not contain, so the step would die on the first deploy.
   `scripts/migrate.mjs` is plain ESM calling the same migrator over the same
   `drizzle/` folder, importing only `drizzle-orm` and `postgres` — both
   already in the image. `scripts/verify-image.sh` runs it inside the built
   image on every check.
6. **Second application** from the same repo for the worker: Dockerfile target
   `worker`, `WORKER_ENABLED=true`, no domain, no health check on a port. The
   worker serves no HTTP, so the image declares `HEALTHCHECK NONE` for that
   stage — watch its five-minute heartbeat instead (README → Monitoring).
6b. **Health check on the web service:** set the path to `/api/health`. It
   answers 200 only when the database is reachable, so a container that is
   listening but cannot serve is drained instead of left answering 500s. The
   image also carries its own `HEALTHCHECK` on the same endpoint; Coolify runs
   its check independently, so configure both and keep them agreeing.
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

   **Give each site its own Redis database index, or its own `CACHE_NAMESPACE`.**
   That sweep `DEL`s every key under `<namespace>:*` outside the running build's
   prefix, so two clones sharing both a Redis database and the default `nextjs`
   namespace delete each other's cache on every deploy — and nothing reports it,
   because a swept key is indistinguishable from a cold one. Either is enough:
   point each site at a different index (`redis://host:6379/3`, `…/4`, …), or set
   `CACHE_NAMESPACE` per site. It is optional, defaults to `nextjs`, takes
   letters, digits, `_` and `-` up to 64 characters, and a value outside that
   fails the boot rather than silently reverting to the shared default.
   `scripts/purge-cache.sh` reads the same variable.

9. **Wire up automatic deploys from GitHub Actions (optional, recommended).**
   `.github/workflows/deploy.yml` calls Coolify's deploy API for both
   applications above — web first, then worker, because migrations run at
   web boot — once `.github/workflows/ci.yml` passes on `main` (or on demand
   from the Actions tab, which re-deploys the branch Coolify is configured
   with; it cannot deploy any other branch), then runs `scripts/smoke.sh`
   against the live site and fails the job if it isn't actually serving or
   is still `noindex`. It needs four
   **repository secrets** (repo → Settings → Secrets and variables → Actions
   → Secrets) and never has them printed anywhere:

   | Secret | Where to find it |
   | --- | --- |
   | `COOLIFY_BASE` | Your Coolify instance's URL. |
   | `COOLIFY_TOKEN` | Coolify → avatar → **Keys & Tokens** → create an API token with deploy permission. Shown once. |
   | `COOLIFY_WEB_UUID` | The web app's own page in Coolify — the UUID in that page's URL. |
   | `COOLIFY_WORKER_UUID` | Same, for the worker app from step 6. |

   Also set one **repository variable** (same page, **Variables** tab —
   public, not secret): `SITE_URL`, matching `NEXT_PUBLIC_SITE_URL`.

   Skip this step and the site still deploys — trigger it by hand from
   Coolify's UI instead. Without the secrets, `deploy.yml` still runs on every
   push to `main` but fails immediately and loudly (`COOLIFY_BASE is not
   set`) rather than doing nothing or doing the wrong thing.

---

## 4b. Make the first admin (5 minutes)

There is no UI for this and there is not going to be one: `profiles.role` is
the only thing `/admin` checks, and nothing a browser sends can set it. Sign
up through the deployed site's `/signup`, then run this
against the production database (`psql "$DATABASE_URL"`, or the database
container's terminal in Coolify):

```sql
insert into profiles (user_id, role)
select id, 'admin' from "user" where email = 'you@example.co.uk'
on conflict (user_id) do update set role = 'admin';
```

`profiles` is created on the first write, not at signup, which is why this
inserts rather than updates. Reload `/admin`; a non-admin gets a 404 there,
so a 404 after this means the email did not match. Use `'owner'` in the same
statement, plus `listings.owner_id`, to hand a listing to a business by hand.

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

Neighbourhood pages (`geo.neighbourhoods`, niche-national only, off by
default) have their own gate: `noindex` and out of the sitemap until they hold
`geo.neighbourhoods.minListings` published listings. Turn the module on only
once listings carry coordinates — assignment is by distance, and a listing
without `lat`/`lng` joins no neighbourhood. See README "Neighbourhoods under
towns".

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
bash scripts/verify-clone.sh    # the clone proof, end to end
```

Knobs, all optional: `CLONE_ANSWERS` (repo-relative path to the answers file,
default `docs/examples/answers.example.json`), `CLONE_PORT` (3240),
`CLONE_REDIS_URL` (`redis://localhost:6380/6` — use an index nothing else uses),
`CLONE_DB_NAME` (`directory_clone`, always created fresh and dropped after),
`CLONE_PROOF_DIR` (where the copy is built; defaults to your temp dir), and
`--keep` to leave the copy, the database and the logs behind. A failed run
keeps its logs regardless.

`check:strings` derives its banned list from the current niche. Regenerate it
for the new site — a plumber directory should ban "plumber", not the word the
template happened to ship with.

**Run `bash scripts/verify-clone.sh` before you announce.** It is the one check
that exercises the product rather than the template: it takes a clean copy of
`HEAD`, answers the wizard from `docs/examples/answers.example.json`, gives the
result its own database (`directory_clone`, never the dev or test one),
migrates, seeds, type-checks, string-checks, builds for production, boots the
standalone server on port 3240 against Redis database 6, fetches the home
page, a city, a listing, the sitemap and `robots.txt` — refusing any page that
still mentions the demo niche — and then runs the whole Playwright suite
against it. It prints a timing table and exits non-zero on the first failure.
`--keep` leaves the clone and its database behind to look at. Anything it
finds is a platform bug: fix it in the tree, with a test, not in the script.
