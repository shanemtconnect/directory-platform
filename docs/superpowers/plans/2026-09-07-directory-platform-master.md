# Reusable City Directory Platform — Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`.
> This is the **master plan**: architecture, corrected schema, phase gates and decisions.
> Bite-sized TDD task plans are written **per phase, just before that phase starts**, as
> `docs/superpowers/plans/YYYY-MM-DD-phase-N-<name>.md`. Writing 8 phases of step-level tasks
> up front would be ~10k lines of guesswork that goes stale by Phase 3.

**Goal:** One Next.js codebase that clones into a new niche directory in under 4 hours — change one
config file, seed cities and categories, deploy.

**Architecture:** One stack per site (own container, own Postgres database, own domain), sharing a
Postgres server, Redis and a reverse proxy on a single box. Everything niche-specific lives in
`config/site.config.ts` (build-time constants, tree-shakeable feature flags) or in seeded database
rows. A single `PillarScope` abstraction serves both site modes so the router never forks.

**Tech stack:** Next.js 16 (App Router, RSC, `output: 'standalone'`), TypeScript strict, Drizzle +
PostgreSQL 16, Better Auth, Cloudflare R2 + Cloudflare CDN, Redis-backed ISR cache handler,
Tailwind + shadcn/ui, PayPal Subscriptions, MapLibre + MapTiler, Resend + React Email, Cloudflare Turnstile, `sharp`
worker image pipeline, Docker via Coolify, Sentry + Uptime Kuma. Node 20+, pnpm.

---

## Global Constraints

Copied verbatim from the brief. Every task inherits these.

1. **The clone test.** "When I clone this repo for a different niche next month, does this line of
   code need to change?" If yes it belongs in config or the database, not in a component.
2. **Never hardcode a niche string in a component.** "Venue", "wedding", "couples" — all of it comes
   from `siteConfig.entity`. Grep for hardcoded strings before each phase is called done.
3. **Strict TypeScript, no `any`.**
3b. **Never connect to Redis during `next build`.** Guard the cache handler on
   `PHASE_PRODUCTION_BUILD !== process.env.NEXT_PHASE` and fall back to local LRU when Redis is
   unreachable, with a `connectTimeout` and a bounded `reconnectStrategy`. Without this the build
   hangs forever on an unreachable Redis — silently, with no error. Proven in the Phase 0 spike.
   Working handler: `reference/cache-handler.mjs`.
4. **Core is unflagged.** Cities, categories, listings, search, submissions, claims, tiers/billing,
   badges, coupons, schema, admin, sitemap, owner ROI dashboard, trust & safety. No flags on these.
5. **Flags are build-time constants** typed from the config object. Never read a flag from the database.
6. **Migrations are shared, always run.** All tables exist on every site regardless of flags.
7. **`validateConfig()` throws at build time** on an unmet feature dependency or a missing env var.
   Fail the build, don't warn.
8. **Two CI builds must pass** before any phase is done: `pnpm build:flags-off` and
   `pnpm build:flags-on`, with zero dead links in either.
9. **All database access goes through `/lib/db/queries/`.** No Drizzle calls in components or route
   handlers. Every query function takes an explicit `viewer: Viewer` and applies its own filter.
   A query function without a viewer is a bug.
10. **Public listing queries always filter `status = 'published'`** via one `publishedListings()` base query.
11. **Region/county/state never appears in a URL.** Database and schema.org only.
12. **The city indexing gate is never bypassed.** `is_indexable` requires
    `listing_count >= seo.minListingsToIndex` AND `intro_html IS NOT NULL`.
13. **Never fabricate `aggregateRating` or `review`.** No seeded, bought or written reviews — not
    even for demos. Use `NEXT_PUBLIC_DEMO_MODE` for local visual filler.
14. **Markup must match visible page content.** If the rating isn't on the page it isn't in the JSON-LD.
15. **`claim-documents` is a private bucket with no public access policy.** Reads only via 15-minute
    presigned URLs from an admin-only route handler, every generation written to `audit_log`.
16. **Verification is never a payment side effect.** Payment opens the job; a human closes it.
17. **Never gate contact details or charge searchers.** The searcher side stays free and public.
18. **The location switcher must never change what a canonical URL returns.**
19. **Every paginated link is a real `<a href>` to a real server-rendered URL.**
20. **The map is never required to see the listings.** List renders server-side, map hydrates on top,
    tile failure collapses the container silently.
21. **Payment webhooks must be idempotent.** Store processed event ids and skip duplicates.
22. **Images:** validate magic bytes not extension, strip EXIF, convert to WebP, cap 8 MB.
23. **Never run `next/image` optimisation on the app server.** Derivatives are generated once in the
    worker at upload time.
24. **Any slug change writes a `redirects` row and serves a 301.** Never break a URL.

---

## Part A — Findings: what I am changing from the brief, and why

### A1. Resolved blocker — payments

| # | Finding | Resolution |
|---|---|---|
| **B1** | **Stripe is region-blocked for Jersey.** The brief mandates it in the stack table, §5.3 checkout/trials/portal, §5.6 Coupon + Promotion Code API sync, §5B.11 payouts, `pnpm stripe:setup` and five `STRIPE_PRICE_*` env vars. | **PayPal only** (decided 2026-09-07). Already live and signature-verified in Toolkit-App, so there is working webhook code to copy. Paddle stays deferred. See Part G1 for what this costs us. |

### A1b. Resolved — the verification model

**Decided by Shane 2026-09-07: verification is a subscription benefit, not a separate product.**

| State | How you get it | Badge | Rank weight |
|---|---|---|---|
| **Unclaimed** | Default for every imported listing | "Unverified" + "Claim this listing free" | 0 |
| **Claimed** | Free, one click, prove control via the §5.2 evidence ladder | Unverified badge removed, "Claimed by owner" | +10 |
| **Verified** | An **active paid annual subscription** (Essential or Premium) plus proven control | "Verified — checked {Month Year}" + the checks panel | +25 |

What this changes from the brief:

- The **£47 standalone verification product is gone.** One thing to sell, not two. §5B.7's separate
  order flow, its own price and its `premium_waiver` concept all collapse into the subscription.
- **Expiry becomes automatic and better.** `verified_expires_at` tracks the subscription's
  `current_period_end` rather than a hand-set +12 months. Lapse, cancel or failed payment drops the
  listing back to Claimed with no separate expiry job to get wrong.
- `verificationIncluded` is now **true on Essential and Premium**, false on Free.
- `paidVerification` stops being a feature flag and becomes core, since every site with a paid tier
  has it.

**One constraint I am keeping, and why it costs nothing.** Payment alone does not set the badge —
the owner must also have proven control of the business through the existing evidence ladder
(domain email match, or phone OTP, or documents). That check already exists for claiming, most
claims clear it in under 60 seconds automatically, and it is the difference between a badge that
says "we checked this is really them" and one that says "they paid".

That distinction matters commercially and legally. A "Verified" badge whose only criterion is
payment is a misleading action under the UK's DMCC Act 2024 — the CMA has direct fining powers of up
to 10% of global turnover, and the brief's own §5B.7 makes this argument at length. Requiring the
control check keeps the badge honest, keeps the subscription exactly as sellable, and adds no work
because Phase 4 builds the ladder anyway. **The words on the badge and the panel are worth a
lawyer's half-hour before launch** — I am not one, and the wording is the part that carries the risk,
not the model.

### A2. Substitutions I am making (stated as assumptions — tell me if wrong)

| # | Brief says | I'm doing | Why |
|---|---|---|---|
| S1 | Docker Compose per site + Caddy + GHCR + `ssh docker compose pull` | **Coolify** on the existing host as the orchestrator; shared Postgres and Redis as Coolify resources | Coolify *is* Docker Compose plus a TLS-terminating proxy plus a deploy pipeline, it is already running your other 15 sites, you have API access, and every one of your deploy runbooks assumes it. Standing up a second parallel Caddy stack on the same box means two things fighting over :443. Coolify keeps the brief's guarantee — separate container, separate database, `pg_dump` and go. |
| S2 | Migrations run in a one-shot container before the app | Coolify pre-deploy command runs `drizzle-kit migrate` | Same guarantee, native to the platform. |
| S3 | `legalEntity: "eCentury Ltd"` | Left as a config placeholder, **flagged for you to confirm** | Affects terms, privacy notice, payment onboarding and the JOIC registration. Not blocking Phase 1. |
| S4 | "UK/Jersey data protection rules" treated as one thing | Treated as **two**: Jersey DPA 2018 (JOIC registration, you as controller) **and** UK GDPR Art 3(2) if you target UK data subjects, which a UK national directory does | The brief's data-protection design (evidence ladder, 30-day purge, transparency page, one-click removal) is right and I'm keeping all of it. The registration/representative question is a you-and-a-lawyer item before launch, not a code item. |
| S5 | Resend for everything including bulk claim-outreach campaigns (§5B.8) | Resend for **transactional only**; claim-outreach campaigns get a separate sending identity on `mail.{domain}` and a provider whose terms permit B2B cold outreach | Resend's acceptable-use terms prohibit cold/unsolicited email. Running §5B.8 campaigns through it risks the account that also sends your password resets. Two senders, two reputations — which is what the brief's own "send from a subdomain, warm slowly" advice implies anyway. |
| S6 | `@neshca/cache-handler` for Redis ISR | **`@fortedigital/nextjs-cache-handler` >= 3.3.0 on Next 16.** Spike run 2026-09-07 — **PASS**, see `docs/spikes/2026-09-07-phase-0-isr-cache-handler.md` | `@neshca` is abandoned (last publish 2024-11-26) and declares `next: ">= 13.5.1 < 15"` — it cannot install on Next 15, never mind 16. Its maintained fork can. Below 3.3.0 on Next >= 16.3.0 the App Router retries `/_tree` prefetches indefinitely, so the floor is hard. |
| S6b | Next.js 15 ("do not substitute") | **Next.js 16** (16.3.4) | 15 is the previous major. Better Auth 1.7.3 declares `^14 \|\| ^15 \|\| ^16`; Drizzle 0.45.2 matches its peer range; the cache handler's actively-developed 3.x line *requires* 16. Every caching feature we use is supported on 16 — the unsupported column is confined to Next 16's new `use cache`/`cacheComponents` model, which this design does not use. Choosing 15 means starting on a maintenance branch and migrating within the year. |
| S7 | `profiles.user_id (FK auth.users)` | `profiles.user_id` FK to Better Auth's `user` table | `auth.users` is Supabase's schema. We aren't using Supabase. |
| S8 | ~~Verification price "£49/yr" vs "£47"~~ | **Moot — superseded by A1b.** There is no standalone verification price; verification comes with an Essential or Premium subscription. | — |

### A3. Design holes in the brief that I'm filling

| # | Hole | Fix |
|---|---|---|
| **H1** | **Second-segment slug collision.** `/[city]/[category]` and `/[city]/[listing-slug]` are the same router shape. A listing slugged `barn-venues` in Manchester collides with the category page. Same problem in `local-multi-vertical`: `/plumbers/st-helier` — area or listing? The brief's rules (city slugs globally unique, listing slugs unique per city) don't cover it. | A **global `slugs` registry table**: `(parent_scope, slug)` unique, where `parent_scope` is the literal `'root'` or the uuid of the owning city/vertical, and each row carries `kind` (`static \| city \| vertical \| area \| category \| listing`) and `entity_id`. Every insert writes a row; the database enforces uniqueness across kinds; `RESERVED_SLUGS` are pre-seeded as `kind='static'` rows so the constraint catches them too. The router does **one** lookup and gets the kind back — no ordered fallback, no mode-specific branching, and it's why the two site modes share a router. |
| **H2** | **Schema block in §4 is incomplete.** Missing entirely: `verticals`, `areas`, `verification_orders`, `reviews`, `price_data`, `suppressions`, `removal_requests`, `reports`, campaign tables, webhook-idempotency table, stats tables. Missing columns referenced in prose: `listings.claim_status`, `verified_expires_at`, `verification_checks`, `verified_by`, `rating_avg`, `rating_count`, `source_url`, `imported_at`. Enum mismatches: `source` lacks `scraped` (§5.2b uses it), `status` lacks `removed` (§5.2b sets it). | Consolidated schema in Part C below. All tables ship on every site per constraint 6. |
| **H3** | **`/membership` is listed as a flagged route** in §3 but §2.1 says paid searcher membership is "not building, ever". | Route dropped. No `consumerMembership` flag. |
| **H4** | **`siteConfig.reviewCriteria` is referenced in §5B.1** but absent from the config example in §2. | Added to the config type. |
| **H5** | **Verification expiry is untestable as specced.** "Test the expiry by moving the clock, not by waiting" needs an injectable clock; `new Date()` scattered through the worker makes that impossible. | A single `lib/clock.ts` `now()` seam, injected into every job. Tests fake it. Lint rule bans bare `new Date()` outside that module. |
| **H6** | **Two sections are both numbered 5B.8** (claim outreach and job board). | Renumbered internally: claim outreach = 5B.8, job board = 5B.8b. Cosmetic. |
| **H7** | **`md5(id \|\| current_date)` shuffle depends on server timezone**, and flips at midnight mid-ISR-window. | Keep the expression; pin it to the site's configured locale timezone rather than server local, and schedule the daily `revalidateTag('listings')` just after the flip so the shuffle and the cache change together. |
| **H8** | **Free tier `showWebsite: false`** sits in tension with constraint 17 (never gate contact details). | Keeping it — phone, address and the enquiry form stay public on every tier, so contact is never gated; only the outbound website link is a paid perk. Flagging it so the decision is deliberate rather than accidental. |

---

## Part B — What we're actually building, in one paragraph

A rank-and-rent asset factory. Each site launches with scraped **facts only** (never copied text or
photos), which makes every listing unclaimed and worth nothing until an owner turns up. The entire
business is the two-step conversion funnel: **unclaimed → claimed** (free, evidence ladder, 30
seconds) and **claimed → verified** (an active paid annual subscription plus proven control of the
business, expiring automatically with the subscription). Everything else — city pillar pages, reviews, badges, shortlists, cost guides,
the footer matrix — exists to drive organic traffic into that funnel or to give an owner a number at
renewal time. The moat is review volume and the cloning speed; site number eleven going live in an
afternoon is the actual product.

---

## Part C — Consolidated database schema

All tables: `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`,
`updated_at timestamptz not null default now()`. Written as Drizzle migrations. No RLS — the data
layer in `/lib/db/queries/` is the single gate (constraint 9).

### C1. Identity (Better Auth owns `user`, `session`, `account`, `verification`)

```
profiles              user_id (FK user.id, unique), role enum(user|owner|admin) default 'user',
                      name, phone, billing_customer_id, marketing_opt_in bool
```

### C2. Geography and taxonomy

```
slugs                 parent_scope text not null,        -- 'root' | uuid of city/vertical
                      slug text not null,
                      kind enum(static|city|vertical|area|category|listing) not null,
                      entity_id uuid,
                      UNIQUE (parent_scope, slug)

verticals             name, slug, singular, plural, Singular, Plural, owner_noun,
                      schema_type, icon, intro_html, sort_order, is_active bool
                      -- niche-national has exactly one implicit row, never in a URL

cities                name, slug (unique), region, country, lat, lng, population,
                      intro_html, faq jsonb, meta_title, meta_description, hero_image_url,
                      is_published bool default true, is_indexable bool default false,
                      listing_count int default 0,          -- trigger-maintained
                      created_by enum(seed|admin|auto)

areas                 name, slug, lat, lng, intro_html, faq jsonb, meta_title,
                      meta_description, is_published bool, is_indexable bool,
                      listing_count int default 0
                      -- local-multi-vertical only; unused table on other sites

categories            vertical_id (FK), name, slug (unique), singular, plural, description,
                      icon, schema_type_override, parent_id (self FK), sort_order,
                      is_active bool
```

### C3. Listings

```
listings              name, slug, city_id (FK), area_id (FK, nullable),
                      vertical_id (FK), primary_category_id (FK),
                      status enum(draft|pending|published|rejected|archived|removed),
                      tier enum(free|essential|premium) default 'free',
                      claim_status enum(unclaimed|claimed|verified) default 'unclaimed',
                      owner_id (FK profiles, nullable),
                      address_line1, address_line2, postcode, lat, lng,
                      phone, email, website, socials jsonb,
                      short_description, description, opening_hours jsonb, timezone,
                      custom_fields jsonb, price_range,
                      rank_boost int default 0,
                      rating_avg numeric(2,1), rating_count int default 0,   -- trigger-maintained
                      verified_at, verified_expires_at, verified_by (FK profiles),
                      verification_checks jsonb,   -- [{check,result,checked_at,note,expires_at}]
                      view_count int default 0, enquiry_count int default 0,
                      source enum(seed|admin|public|import|scraped), source_url, imported_at,
                      submitted_by_email, published_at, rejected_reason
                      UNIQUE (city_id, slug)

listing_categories    listing_id, category_id                      -- many-to-many
listing_images        listing_id, storage_path, derivatives jsonb,  -- {thumb,card,hero,full}
                      alt, width, height, sort_order, is_primary bool
```

Note: `is_verified` from the brief is **removed** — `claim_status = 'verified'` is the single source
of truth, so a paid tier can never accidentally set a boolean that reads as verified.

### C4. Ownership and verification

```
claims                listing_id, user_id, status enum(pending|approved|rejected|withdrawn),
                      claimant_name, role_at_business, business_email, business_phone,
                      evidence_type enum(domain_email|phone_otp|document|id_document),
                      evidence_notes, id_document_path, proof_document_path,
                      email_verified_at, phone_verified_at, magic_token, magic_token_expires_at,
                      decided_by, decided_at, admin_notes, rejection_reason,
                      documents_purged_at, ip, user_agent

verification_checks_log  listing_id, subscription_id, user_id,
                      status enum(open|docs_pending|call_scheduled|passed|failed|cancelled),
                      evidence_type enum(domain_email|phone_otp|document|id_document),
                      checklist jsonb, call_scheduled_at, signed_off_by, signed_off_at,
                      notes
                      -- Opened when a subscription activates. Verified requires BOTH an
                      -- active subscription AND a passed check. No fee column: the check
                      -- is bundled, there is nothing separate to charge for.
```

### C5. Money

```
subscriptions         listing_id, user_id, provider default 'paypal', provider_customer_id,
                      provider_subscription_id, provider_price_id, tier,
                      interval enum(monthly|annual), status, trial_ends_at,
                      current_period_end, cancel_at_period_end

coupons               code (unique, uppercase), description,
                      discount_type enum(percent|fixed), value,
                      applies_to_tiers text[], applies_to_intervals text[],
                      max_redemptions, redemption_count, starts_at, expires_at,
                      provider_coupon_id, provider_promo_id, is_active, created_by, batch_id

coupon_redemptions    coupon_id, user_id, listing_id, subscription_id, redeemed_at

processed_events      provider, event_id (unique), processed_at, payload jsonb
```

Provider-neutral column names throughout: PayPal is the decided provider, but a future move to
Paddle changes `lib/billing/` and not a migration. `provider_coupon_id` / `provider_promo_id` stay
nullable and go unused under PayPal (G1a).

### C6. Demand side and trust

```
enquiries             listing_id, name, email, phone, message, is_spam bool,
                      read_at, replied_at, responded_in_minutes, ip

reports               listing_id, reason enum(incorrect|closed|duplicate|offensive|other),
                      detail, reporter_email, status enum(open|actioned|dismissed), ip

removal_requests      listing_id, requester_name, requester_email, relationship, reason,
                      status enum(open|actioned|rejected), due_at,   -- 5 working day SLA
                      actioned_by, actioned_at

suppressions          name_normalised, postcode_normalised, email, phone, reason,
                      created_by                                   -- blocks re-import forever
```

### C7. SEO plumbing and ops

```
redirects             from_path (unique), to_path, status_code int default 301
audit_log             actor_id, action, entity_type, entity_id, meta jsonb, ip
job_runs              job_name, started_at, finished_at, status, error, lock_key
listing_stats_daily   listing_id, day date, views, impressions, enquiries,
                      shortlist_adds, badge_clicks
                      UNIQUE (listing_id, day)
badges                listing_id, style enum(dark|light|compact|rating), snippet_html,
                      backlink_url, backlink_verified bool, last_checked_at,
                      impression_count, click_count
```

### C8. Flagged-module tables (created on every site, used when the flag is on)

```
reviews               listing_id, author_email, author_display_name, rating int,
                      sub_ratings jsonb, title, body,
                      status enum(pending|published|rejected|disputed),
                      email_verified_at, flagged_reason, ip
review_photos         review_id, storage_path, derivatives jsonb, alt
review_replies        review_id, listing_id, author_id, body, status
review_invites        listing_id, token (unique), sent_to, sent_at, used_at

shortlists            user_id (nullable), cookie_id, name, share_id (unique), is_public bool
shortlist_items       shortlist_id, listing_id, note, sort_order

price_data            service, city_id (nullable), low, median, high, sample_size,
                      currency, methodology_note, source_name, source_url, updated_at

quote_requests        name, email, phone, message, city_id, category_id, ip
quote_recipients      quote_request_id, listing_id, contact_masked bool,
                      opened_at, replied_at

jobs                  title, description, city_id, category_id, budget_min, budget_max,
                      poster_email, status enum(pending|published|expired|removed),
                      expires_at
job_applications      job_id, listing_id, message, created_at

awards                year int, city_id (nullable), category_id (nullable), listing_id,
                      rank int, methodology_version, published_at

affiliates            user_id, code (unique), commission_pct, status
referrals             affiliate_id, subscription_id, amount, status, paid_at

campaigns             name, segment jsonb, channel enum(email|sms), template_key,
                      status, scheduled_at, sent_count, opened_count,
                      claimed_count, converted_count
campaign_messages     campaign_id, listing_id, to_address, magic_token,
                      sent_at, opened_at, clicked_at, bounced_at, unsubscribed_at
unsubscribes          address_normalised (unique), reason, created_at   -- honoured forever, all sites
```

---

## Part D — Routing

### D1. Resolution

One dynamic catch-all resolver backed by the `slugs` table (H1). Given `/a` or `/a/b`:

1. `RESERVED_SLUGS` are `kind='static'` rows in `slugs` under `parent_scope='root'` — the constraint
   rejects a colliding city or vertical at insert time, and the resolver returns the static route.
2. `/a` → lookup `('root', a)`. `kind='city'` → city pillar. `kind='vertical'` → vertical pillar.
   Miss → check `redirects`, else 404.
3. `/a/b` → resolve `a` first, then lookup `(a.entity_id, b)`. `kind='category'` → city+category or
   vertical+category. `kind='area'` → vertical+area. `kind='listing'` → listing detail.
4. Every resolution result is one `PillarScope` value. One query builder, one sort expression, one
   schema builder, one component tree. The site mode only decides which scopes
   `generateStaticParams` emits and what the homepage renders.

### D2. Canonical route table

Core (no flag): `/`, `/[city]`, `/[city]/[category]`, `/[city]/[listing]`, `/cities`,
`/categories`, `/categories/[category]`, `/search`, `/add-listing`, `/claim/[listing]`, `/pricing`,
`/advertise`, `/advertise/badge`, `/badge/[id].svg`, `/blog`, `/blog/[slug]`, `/trust`,
`/data-sources`, `/account/*`, `/admin/*`, `/sitemap*.xml`, `/robots.txt`.

Flagged (each `guardFeature()` → real 404 when off): `/[city]/[listing]/reviews`,
`/leave-review/[listing]` · `/shortlist`, `/shortlist/[shareId]` · `/cost`, `/cost/[service]`,
`/cost/[service]/[city]` · `/get-quotes` · `/guides`, `/guides/[topic]`, `/guides/[topic]/[slug]`
(replaces `/blog`) · `/jobs`, `/jobs/[id]`, `/post-a-job` · `/awards`, `/awards/[year]`,
`/awards/[year]/[city]` · `/affiliates` · `/tools/[tool]`.

`local-multi-vertical` swaps `/[city]` for `/[vertical]` and adds `/areas`, `/areas/[area]`.

`/membership` is dropped (H3).

Nav, footer, sitemap, breadcrumbs and schema all read from **one** derived source,
`/lib/features/navigation.ts`. A surviving link after a flag flips is a build-failing bug.

---

## Part E — File structure

```
config/site.config.ts            the only file a clone edits
config/validate.ts               validateConfig(): deps + env, throws at build
cache-handler.mjs                Redis ISR handler (build-guarded, LRU fallback) — see reference/
lib/clock.ts                     now() seam (H5)
lib/routing/reserved.ts          RESERVED_SLUGS
lib/routing/resolve.ts           slug registry lookup → PillarScope
lib/routing/slugs.ts             slug allocation + redirect-on-change
lib/features/flags.ts            typed build-time constants
lib/features/guard.ts            guardFeature()
lib/features/navigation.ts       single source for nav/footer/sitemap/breadcrumbs
lib/db/schema/*.ts               Drizzle tables, one file per domain group
lib/db/queries/*.ts             every query takes viewer: Viewer
lib/db/sort.ts                   the one ranking expression
lib/schema/*.ts                  JSON-LD builders, one per page type
lib/billing/                     PayPal adapter — subscriptions, plan_overrides, webhook
                                 signature verification, local coupon enforcement
lib/media/                       R2 presign, magic-byte validation
lib/email/                       React Email templates
components/pillar/PillarPage.tsx one component, four scopes
components/listing/…             cards, detail, verification panel, claim/verify CTAs
worker/jobs/*.ts                 node-cron jobs, each takes a Postgres advisory lock
scripts/new-site.ts              the clone kit
scripts/seed.ts                  pnpm seed
seeds/{niche}/{cities,categories,listings}.csv
docs/CLONING.md
```

---

## Part F — Phase plan and gates

Each phase must be deployable and demoable. A phase is done only when its gate passes **and**
`build:flags-off` + `build:flags-on` both pass clean.

| Phase | Scope | Gate | Estimate |
|---|---|---|---|
| **0** | ~~Spike: Redis ISR cache handler~~ **DONE 2026-09-07 — PASS.** Outstanding: confirm legal entity (S3). | ~~Cache handler survives a redeploy with a warm cache~~ **Met**: a runtime-regenerated page survived a filesystem wipe and was served from Redis. | **done (2h)** |
| **1** | Scaffold, Coolify stack, full Drizzle schema, slug registry, `PillarScope`, config + flags + `validateConfig`, theme tokens, image derivative worker, seed script, CSV importer with all §5.2b guardrails, deploy pipeline. | `pnpm seed` loads 50 cities / 20 categories / 200 listings; `/[city]` renders over HTTPS on a real domain; a redeploy does not cold-start the ISR cache. | **1.5–2 weeks** |
| **2** | Home, city pillar, city+category, listing detail, category & cities indexes, faceted search, map, enquiry form, full JSON-LD, split sitemap index, robots. | Lighthouse SEO 100; every page type passes Rich Results Test; sitemap validates; a Playwright test asserts every pagination link is a real `<a href>`. | **2 weeks** |
| **3** | Better Auth, `/add-listing` + Turnstile + duplicate detection, location switcher, admin submission queue, auto city creation + indexing gate, transactional email. | A stranger submits into a brand-new city, you approve, the pillar page exists and is **noindexed until it has 3 listings**. | **1.5 weeks** |
| **4** | Claim evidence ladder, private bucket, presigned admin review, approve/reject, 30-day purge job, owner dashboard. | Domain-email claim auto-approves in under 60s; a Playwright test fetches a claim document URL unauthenticated and asserts 403. | **1.5 weeks** |
| **5** | PayPal Subscriptions adapter, `/pricing` rendered from config, checkout, trials, signature-verified webhooks, hand-built billing page (G1b), local coupon enforcement (G1a), tier-driven ranking + image limits, downgrade, **three-state verification ladder driven by subscription status**, owner ROI dashboard. | Upgrade pushes a listing to the top within one revalidation cycle **and sets Verified once the control check passes**; cancelling drops the listing back to Claimed and removes the badge within one revalidation cycle; renewal reminders fire at 30/7/0 days — **tested by moving the clock**. | **3–3.5 weeks** (G1a–G1c add ~4 days over the Stripe assumption) |
| **6** | Coupons + bulk generation, `/advertise`, badge generator (4 styles) + anchor variants, backlink cron. Then tier-1 modules in the brief's stated order: **verification ladder + claim outreach first**, then reviews, shortlist, footer link matrix. Cost guides only where volume justifies. | 50 outreach codes export as CSV; an external badge is detected within a week; both flag builds pass with zero dead links. | **3 weeks** |
| **7** | MDX blog / content hub, 404 + 500, Plausible, Sentry, Playwright smoke tests on the five critical flows. | Five flows green in CI. | **1 week** |
| **8** | `scripts/new-site.ts`, demo seed data, `/docs/CLONING.md`. | A second directory in a different niche stands up in **under 4 hours**. | **1 week** |

Roughly **14–16 weeks** of focused work to Phase 8. Phases 1–5 (a sellable site) is about 9–10 weeks.

---

## Part G — Risks

1. **PayPal is weaker than Stripe in four specific places.** None are fatal; all are Phase 5 work the
   brief did not budget for, so they are written down here rather than discovered in week 10.

   **G1a — No promotion-code primitive.** Stripe Promotion Codes enforce limits at checkout; PayPal
   has nothing equivalent for subscriptions, and you cannot create a PayPal plan per code (§5.6 wants
   50 unique single-use codes for outreach). Fix: our `coupons` table is the enforcer. Validate the
   code server-side, then create the subscription with **`plan_overrides`** — PayPal accepts
   overridden `billing_cycles` pricing at subscription-creation time, which covers percent-off and
   fixed-off on the first period. `provider_coupon_id` / `provider_promo_id` in the schema stay
   nullable and unused. Redemption counting, expiry and tier/interval eligibility all become ours.
   Add a concurrency test: two simultaneous redemptions of a `max_redemptions: 1` code must not both
   succeed.

   **G1b — No billing portal.** Stripe's hosted portal is a link; PayPal has none. `/account/billing`
   gets built by hand: current tier, next billing date, invoice history from
   `PAYMENT.SALE.COMPLETED` events, a cancel button hitting the cancel-subscription API, and payment
   method updates handed off to PayPal's own hosted flow. Budget ~3 days.

   **G1c — "Capture card up front, trial starts on approval" does not map cleanly.** A PayPal
   subscription activates when the buyer approves it, not when *we* approve the listing, so the
   reference site's one-page flow can't be copied exactly. Take the least-surprising option: at
   submission we record the chosen tier and take **no payment**; on admin approval the confirmation
   email carries a one-click activate-your-trial link into PayPal. Slightly lower conversion than
   card-up-front, and honest — we never hold a payment instrument for a listing that might be
   rejected. Revisit only if submission-to-paid conversion disappoints.

   **G1d — PayPal is not a merchant of record.** Paddle would have absorbed the UK VAT question;
   PayPal does not. A Jersey company selling £47–£249/yr subscriptions to UK businesses has a VAT
   position to establish before the first invoice. **Not a code task and not blocking Phase 1** —
   flagging it so it is a decision rather than an omission. Worth an accountant's half-hour before
   Phase 5 ships.

   Affiliate payouts (§5B.11) are fine — PayPal Payouts covers it, and Stripe Connect was overkill.

2. **The scraped-data legal surface is the real risk, not the code.** §5.2b's guardrails are
   necessary but not sufficient: a Jersey controller publishing UK sole traders' contact details
   needs a documented lawful basis, a transparency notice, and a working removal route before the
   first listing goes public. Build all three in Phase 1; get them reviewed before Phase 2 ships.
3. **Ten sites on one box.** Each idles a few hundred MB, but ten Next builds, ten worker containers
   and one Postgres is a real memory budget. Uptime Kuma check on free disk and RAM from Phase 1.
4. **Backup restore is the thing that gets skipped.** Weekly restore into a scratch database, and it
   fails loudly. An untested backup is not a backup.
5. **Feature-flag rot** is the specific failure mode this codebase dies of. The two CI builds are the
   only thing preventing it — they are not optional, and they gate every phase.

---

## Part H — Open, non-blocking

1. `legalEntity` — confirm (S3). Also determines the PayPal business account the sites bill through.
1b. VAT position for UK subscription sales from a Jersey company (G1d) — accountant, before Phase 5.
2. Which niche is site #1? Not blocking; Phase 1 builds against the wedding-venue reference config
   and the clone kit exists precisely so this can change late.
3. Whether Phase 6's cost guides apply to site #1 at all — decide from real search volume, not taste.
