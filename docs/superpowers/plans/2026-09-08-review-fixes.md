# Review fixes — 2026-09-08

Source: `docs/reviews/2026-09-08-build-review.md`. Tasks are file-disjoint so they can run in
parallel worktrees. Each task owns the files it lists; do not edit files owned by another task
except where a task explicitly says "shared: append-only".

## Global Constraints (binding on every task)

1. **The clone test.** If a line would need to change when this repo is cloned for a different
   niche, it belongs in `config/site.config.ts` or the database, not in a component.
2. **Never hardcode a niche string in a component.** "Venue", "wedding", "couples" — all of it
   comes from `siteConfig.entity`. `pnpm check:strings` must stay green.
3. **Strict TypeScript, no `any`.** `pnpm typecheck` must stay green.
4. **Never connect to Redis during `next build`.**
5. **Flags are build-time constants.** Never read a flag from the database.
6. **All database access goes through `lib/db/queries/`.** No Drizzle calls in components, route
   handlers or server actions. Every query function takes an explicit `viewer: Viewer`.
7. **Public listing queries always filter `status = 'published'`** via one `publishedListings()`
   base query.
8. **Region/county/state never appears in a URL.**
9. **The city indexing gate is never bypassed.** `is_indexable` requires
   `listing_count >= siteConfig.seo.minListingsToIndex` AND `intro_html IS NOT NULL`.
10. **Never fabricate `aggregateRating` or `review`.**
11. **Markup must match visible page content.** If it isn't rendered it isn't in the JSON-LD.
12. **Every paginated link is a real `<a href>` to a real server-rendered URL.** Pagination is
    `/city/page/2`, never `?page=2`. Reading `searchParams` forces a route dynamic in Next 16.
13. **The map is never required to see the listings.**
14. **Any slug change writes a `redirects` row and serves a 301.** Never break a URL.
15. **Images:** validate magic bytes not extension, strip EXIF, convert to WebP, cap 8 MB.
16. **Tests:** `pnpm test` (vitest, 415 passing at start) and `pnpm typecheck` must pass before
    every commit. Integration tests use `test/db.ts` `withTestDb` (rollback per test) against
    `postgres://directory:directory@localhost:5433/directory_test`. New behaviour gets a test
    first (TDD): write the failing test, then the code.
17. **Commit per logical change** on your branch with a conventional subject
    (`fix(scope): ...`). Never push. Never touch `main`.
18. Node 24, `corepack pnpm`. First run `corepack pnpm install --frozen-lockfile` in your
    worktree. Builds need `NEXT_PUBLIC_SITE_URL=http://localhost:3200 DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev REDIS_URL=redis://localhost:6380`.
19. The dev database `directory_dev` is seeded (50 cities / 20 categories / 200 listings) and
    shared with other parallel workers — read it, never wipe it. The test database is migrated
    to migration `0000`; if you add a migration, run `DATABASE_URL=...directory_test corepack pnpm db:migrate`.
20. Do not run `git clean`, `git reset --hard`, or delete other worktrees.

---

## Task 1: Deploy plumbing and ISR asset retention

**Owns:** `Dockerfile`, `.dockerignore`, `docker-entrypoint.sh` (new), `public/.gitkeep` (new),
`instrumentation.ts` (new), `config/validate.ts`, `config/validate.test.ts`, `worker/index.ts`
(top-of-file env validation only), `cache-handler.mjs` (comments only), `scripts/verify-isr.sh`,
`scripts/purge-cache.sh` (comments only), `docs/spikes/2026-09-07-phase-0-isr-cache-handler.md`,
`README.md` (Local development / deploy sections only), `.env.example`.

**Problems (verified):**
- `Dockerfile:28` copies `public/` which does not exist → `docker build` fails.
- `Dockerfile:37-38` copies `node_modules/@fortedigital` and `@redis`, which under pnpm are
  symlinks into `node_modules/.pnpm/…`; in the image they dangle and their own deps are absent,
  so `cache-handler.mjs` fails to import and the app silently falls back to per-container LRU.
- `Dockerfile:53` runs the worker with `node --experimental-strip-types worker/index.ts`, but
  `worker/index.ts:2` imports `@/lib/db/client` — Node cannot resolve the tsconfig alias.
- `validateEnv(process.env, { phase: "runtime" })` has no callers. Only the build phase runs
  (`next.config.ts:9`). README and `.env.example` claim boot fails on missing env.
- `NEXT_PUBLIC_MAPTILER_KEY` and `NEXT_PUBLIC_MEDIA_URL` are inlined at build time but listed only
  in `RUNTIME_ENV`.
- `.dockerignore` excludes only `.env` and `.env.local`; `.env.production` would be baked in.
- **ISR cache serves HTML that references dead assets after a rebuild.** Redis keys are
  `nextjs:/durham` with no build id. Observed: a cached homepage linked
  `/_next/static/chunks/1i8exnwvl15km.css`, which 404s on the current build. The Phase 0 design
  (cache survives redeploy) is only correct if old `.next/static` files remain servable after a
  redeploy, which is how Vercel does it.
- `legalEntity: "TBC"` and `supportEmail: "hello@example.co.uk"` would ship to production.

**Requirements:**
1. Add `public/.gitkeep` (Dockerfile COPY of `public/` then succeeds).
2. Fix the runner stage so the cache handler actually loads. Preferred: in the builder stage run
   `pnpm deploy --prod --filter . /app/deploy` (or equivalent that produces a real, symlink-free
   `node_modules` containing `@fortedigital/nextjs-cache-handler`, `@redis/client` and their
   transitive deps), then COPY that `node_modules` over the standalone one. Verify in CI-style:
   add a `RUN node -e "import('./cache-handler.mjs')"` smoke step in the runner stage is NOT
   possible without Redis env — instead add a `scripts/verify-image.sh` that builds the image and
   runs `docker run --rm IMAGE node -e "import('./cache-handler.mjs').then(()=>console.log('ok'))"`
   and document it. If Docker is available locally, run it and record the output in your report;
   if not, say so.
3. Worker stage: run with `tsx` (`CMD ["./node_modules/.bin/tsx", "worker/index.ts"]`), and make
   sure `tsx` is present in the worker image (it is a devDependency — either move it to
   `dependencies` or install it in the worker stage). Keep `--experimental-strip-types` out.
4. **Asset retention across deploys.** Add `docker-entrypoint.sh` for the runner stage: if
   `STATIC_ASSETS_DIR` is set (a persistent volume path, e.g. `/data/next-static`), copy the
   image's `.next/static` into it without overwriting (`cp -rn`), then replace `/app/.next/static`
   with a symlink to that dir (or copy the merged dir back). If unset, do nothing. Result: old
   chunk hashes stay servable after a redeploy, so cached HTML keeps working. Document in the
   spike doc and README that the Coolify app must mount a volume at `STATIC_ASSETS_DIR`, and that
   without it you must run `scripts/purge-cache.sh` after every deploy. Update
   `scripts/verify-isr.sh` so it also asserts that the CSS `<link>` in a cached page returns 200
   after the rebuild (that is the check that would have caught this).
5. Runtime env validation: add `instrumentation.ts` at the repo root exporting `register()` that,
   when `process.env.NEXT_RUNTIME === "nodejs"`, calls `validateEnv(process.env, { phase: "runtime" })`.
   Also call it at the top of `worker/index.ts`. Skip validation when `NODE_ENV !== "production"`
   is NOT acceptable — instead, allow a `SKIP_ENV_VALIDATION=1` escape hatch for local/CI runs and
   set it in `playwright.config.ts` `SERVER_ENV`? No — `playwright.config.ts` is owned by Task 9.
   Instead: make `validateEnv` runtime phase only require the variables whose features are wired
   today (`NEXT_PUBLIC_SITE_URL`, `DATABASE_URL`, `REDIS_URL`), and keep the full list under a
   `RUNTIME_ENV_PHASE5` constant with a comment that says which task/phase turns each group on
   (auth, R2, PayPal, email, Turnstile, MapTiler). Turnstile and MapTiler are optional today
   (their code paths degrade). Test both lists in `config/validate.test.ts`.
6. Move `NEXT_PUBLIC_MAPTILER_KEY` and `NEXT_PUBLIC_MEDIA_URL` into `BUILD_ENV` as *optional*
   build-time vars (warn, don't throw, when absent — the map and media degrade), and add
   `ARG NEXT_PUBLIC_MEDIA_URL` to the Dockerfile builder stage like MAPTILER already is.
7. `validateConfig` production guard: add `validateProductionConfig(config, env)` that throws when
   `NODE_ENV === "production"` and `SITE_ENV !== "staging"` if `legalEntity === "TBC"` or
   `supportEmail` ends with `example.co.uk`/`example.com`. Call it from `next.config.ts`
   (build phase). Test it.
8. `.dockerignore`: `.env*` plus `!.env.example`; also ignore `.superpowers/`, `docs/`, `e2e/`,
   `test-results/`, `playwright-report/`, `.next/`.
9. Update `.env.example` comments to match the new required/optional split.

**Tests:** `config/validate.test.ts` covers requirement 5, 6, 7. `pnpm typecheck`, `pnpm test`,
`pnpm build:flags-off` must pass.

---

## Task 2: Anti-abuse and server-action hardening

**Owns:** `lib/spam/**`, `lib/actions/**`, `components/listing/EnquiryForm.tsx`,
`components/submit/TurnstileWidget.tsx`, `components/submit/SubmitListingForm.tsx`,
`components/listing/ListingDetail.tsx` (only to pass the Turnstile site key down),
`lib/db/queries/submissions.ts` + test, `lib/db/queries/enquiries.ts` (new) + test,
`app/badge/[id]/route.ts`, `app/advertise/badge/page.tsx`, `lib/db/queries/badges.ts` (new) + test.

**Problems (verified):**
- `lib/spam/turnstile.ts:20-39` skips verification when the secret is unset and passes on any
  fetch error, with no timeout. Comment claims it "never silently passes in production".
- `lib/spam/rate-limit.ts:47,62` fails open when Redis is unreachable and, because the client is
  only cached when `isReady`, reconnects on every call (3 s connect timeout per submit).
- `lib/actions/enquiry.ts:55` and `submit-listing.ts:169` key the rate limit on the *first*
  `X-Forwarded-For` entry, which the client controls. With no proxy every user shares `"unknown"`.
- `components/listing/EnquiryForm.tsx` never renders `TurnstileWidget`, but `submitEnquiry`
  requires a token whenever `TURNSTILE_SECRET_KEY` is set → every production enquiry fails.
- `submit-listing.ts:181-192` verifies Turnstile (single-use token) *before* validation and
  increments the rate limit before validation; the widget is never reset after an error → every
  retry fails.
- `components/submit/TurnstileWidget.tsx:17-20` relies on implicit rendering; on client-side
  navigation the script is already loaded so the widget never renders.
- `listingId`/`categoryId` (user-controlled) go straight into uuid comparisons; a non-UUID string
  throws `invalid input syntax for type uuid` out of the action.
- `name`/`phone` accept CR/LF (future email header injection).
- `lib/db/queries/submissions.ts:130-153` `findDuplicate` has no status filter: anyone can type a
  phone number and learn the name/slug of pending or removed listings.
- `submit-listing.ts:210` links to `/claim/${slug}` which does not exist and is ambiguous
  (listing slugs are per-city).
- Direct Drizzle in `app/badge/[id]/route.ts:41-52`, `app/advertise/badge/page.tsx:51-57`,
  `lib/actions/enquiry.ts:78-98` with no viewer (constraint 6).

**Requirements:**
1. Turnstile: when `TURNSTILE_SECRET_KEY` is unset → skip **only** if
   `process.env.NODE_ENV !== "production"`; in production with no secret, return
   `{ ok: false, reason: "not-configured" }` and log once. Add `AbortSignal.timeout(5000)`; on
   fetch error/timeout return `{ ok: false, reason: "unreachable" }`. Actions surface a
   "couldn't verify" error. Tests with a mocked `fetch`.
2. Rate limit: read the client IP from the **last** `X-Forwarded-For` hop, else `X-Real-IP`, else
   `null`; when `null`, use a per-request random key (never a shared `"unknown"` bucket). When
   Redis is unreachable, fall back to an in-process Map counter (same limits) and cache the
   failure for 30 s before retrying the connection. Tests: XFF parsing, fallback counter, cooldown.
3. Both actions: order is validate → rate-limit → Turnstile → DB. Add UUID validation for
   `listingId` and `categoryId` (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`)
   returning a field error. Strip `\r`/`\n` from every string field at validation time.
4. `EnquiryForm` renders `TurnstileWidget` when a site key is supplied; `ListingDetail` passes
   `process.env.TURNSTILE_SITE_KEY ?? null` down (server component). `TurnstileWidget` uses explicit
   rendering (`window.turnstile.render(el, { sitekey, callback })`, `onload` callback for first
   load, `remove()` on unmount) and resets when the form action returns an error. Expose the
   token through a hidden input named `cf-turnstile-response` as today.
5. `findDuplicate` takes a viewer; for non-admin viewers match only `status = 'published'` and
   return pending matches as `{ kind: "pending" }` with no name/slug. The duplicate message in the
   action links to the listing's canonical `/{citySlug}/{listingSlug}` page, not `/claim/…`.
6. Move the badge lookups into `lib/db/queries/badges.ts` (`badgeListing(db, viewer, id)`) and the
   enquiry insert into `lib/db/queries/enquiries.ts` (`createEnquiry(db, viewer, input)`) — both
   with `PUBLIC_VIEWER`, published-only, and tests via `withTestDb`.
7. Keep the e2e enquiry test (`e2e/enquiry.spec.ts`) passing without a Turnstile key set (dev
   mode skips).

**Tests:** unit tests for turnstile, rate-limit, action validation; DB tests for the two new
query modules and `findDuplicate` visibility.

---

## Task 3: Routing holes and slug renames

**Owns:** `lib/routing/**`, `app/[...segments]/page.tsx` **lines 80-100 only** (the
`resolveRoute` status handling and the page-bounds check in the pillar branch), `app/categories/[...category]/page.tsx` **numeric parse and bounds only** (around lines 52-53, 82),
`lib/db/schema/ops.ts` (redirects status check constraint), a new migration if needed,
`e2e/routing.spec.ts` (new).

**Problems (all verified with curl, every one returns 200 today):**
- `/leeds/page/999` renders an empty page (soft 404).
- `/Leeds` renders the same page as `/leeds` (no canonical redirect; `redirectFor` is
  case-sensitive).
- `/leeds/page/1` duplicates `/leeds`.
- `/leeds/page/1e0` — `Number()` accepts `1e0`, `0x2`, `02`, ` 2`.
- `/truro/the-grange-estate/page/3` serves the listing as a duplicate.
- `app/[...segments]/page.tsx:89-91`: any non-301 status becomes `redirect()` (307); 410 and
  308 are impossible.
- `reallocateSlug` (`lib/routing/slugs.ts:153-171`) writes one redirect for the renamed path only,
  so `/old-city/<listing>` and `/old-city/<category>` 404 after a city rename (constraint 14). It
  also never updates the entity's own `slug` column (`cities.slug`, `listings.slug`, …), so the
  sitemap/homepage/category links keep emitting the old URL, and chained renames leave two-hop
  301s.
- `allocateSlug` (`slugs.ts:78-87`) is check-then-insert; concurrent same-name inserts hit
  `23505` and abort the caller's transaction instead of taking the next candidate.

**Requirements:**
1. `splitPagination`/numeric parsing: accept only `/^[1-9]\d*$/`. `/page/1` → 301 to the base
   path. `page > totalPages` → `notFound()` (pillar and category pages; total is already computed).
2. Listing results never accept `/page/N` → `notFound()`.
3. If any raw segment differs from its lowercase form → 301 to the lowercased path (before the
   registry lookup). Apply the same to `redirectFor` lookups (lowercase the incoming path).
4. Redirect status handling: `301`/`308` → `permanentRedirect`, `302`/`307` → `redirect`,
   `410` → `notFound()` (a 410 row has no `toPath`; make `to_path` nullable if it isn't, or store
   the same path). Add a DB check constraint on `redirects.status_code IN (301,302,307,308,410)`
   via a new drizzle migration (`pnpm db:generate`, then migrate the test DB).
5. Root-scope prefix redirects: on a root miss, look up a redirect for `/${first}` and, if found,
   301 to `${to}${rest.length ? "/" + rest.join("/") : ""}`. `reallocateSlug` must also update the
   owning entity's `slug` column in the same transaction and rewrite earlier `redirects.to_path`
   rows that pointed at the old path (collapse chains).
6. `allocateSlug`: per candidate, `insert(...).onConflictDoNothing().returning()` and loop to the
   next candidate on empty; drop the pre-check.
7. `e2e/routing.spec.ts`: asserts each of the five URLs above now returns the correct status
   (404 / 301 → `/leeds` / 301 / 404 / 404). Use `request.get(url, { maxRedirects: 0 })`.

**Tests:** `lib/routing/*.test.ts` for every rule above (TDD), plus the e2e file. Existing
`e2e/pagination.spec.ts` must keep passing.

---

## Task 4: Metadata, canonicals, JSON-LD parity, sitemap

**Owns:** `app/layout.tsx`, `app/[...segments]/page.tsx` **except lines 80-100** (metadata,
JSON-LD and props passed to `PillarPage`), `app/categories/[...category]/page.tsx` **except the
numeric-parse/bounds lines**, `app/categories/page.tsx`, `app/cities/page.tsx`, `app/page.tsx`,
`app/blog/**`, `app/pricing/page.tsx`, `app/advertise/page.tsx`, `app/search/page.tsx`,
`app/trust/page.tsx`, `app/data-sources/page.tsx`, `app/sitemap.ts`, `app/robots.ts`,
`app/icon.svg` (new), `app/opengraph-image.tsx` (new), `lib/schema/**`, `lib/blog/**`,
`lib/features/navigation.ts` + test, `lib/db/queries/sitemap.ts` + test,
`lib/db/queries/listing-detail.ts` (only if a field is needed for metadata),
`components/pillar/PillarPage.tsx` (heading count + ItemList paths), `components/seo/**`,
`components/listing/ListingDetail.tsx` **only** the tier-gated fields passed to the schema
builder (coordinate: Task 2 edits the Turnstile prop in the same file — keep your edit to the
schema call and expect a trivial merge), `lib/site-env.ts`.

**Problems (verified):**
- Listing detail pages get `{}` metadata (`app/[...segments]/page.tsx:194-197`): title is the
  bare site name, description is the site tagline.
- No `metadataBase`; relative canonicals on `/pricing`, `/blog/*`, `/advertise` render as
  `href="/pricing"`. No canonicals at all on home, pillar, category, listing, `/cities`,
  `/categories`. No `openGraph`/`twitter`, no icon, no OG image. Every page shares the tagline as
  description.
- `/pricing` title renders "Pricing — Which Wedding Venue | Which Wedding Venue"
  (`app/pricing/page.tsx:21` plus the layout template). `/pricing` reads `searchParams` so its
  `revalidate = 3600` is dead (route is dynamic).
- Nav and sitemap advertise `/guides` (`lib/features/navigation.ts:43`) but the route is `/blog`.
- `ListingDetail.tsx:80-81` links `/claim/{slug}` and `/report/{id}` — neither exists.
- ItemList URLs on `/city/category` pillars are `${basePath}/${slug}` = `/city/category/slug`
  (`app/[...segments]/page.tsx:161`) which 404s; the real URL is `/city/slug`.
- On `/city/category` the h2 reads "{city.listingCount} {plural} in City" — the whole-city count
  (`components/pillar/PillarPage.tsx:71`), contradicting the list and `numberOfItems`.
- Listing JSON-LD (`lib/schema/builders.ts:90-109`) emits `email`, full `description`,
  `priceRange`, `sameAs` regardless of tier; the page renders none of email/price range/socials and
  free tier shows an excerpt (constraint 11).
- `BreadcrumbList` emitted on `/categories`, `/cities`, `/blog`, `/blog/[slug]` with no visible
  breadcrumb nav. `pillarSchema` on `/x/page/2` asserts page 1's `url`/`@id`.
- Sitemap: single flat file; blog posts absent; zero-listing categories listed though their page is
  `noindex` (`categories/[...category]/page.tsx:192`); static routes get `lastModified: now`.
- `lib/blog/posts.ts:138` `SAFE_HREF` accepts `//evil.example/x`; a `# heading` in a post body
  emits a second `<h1>`.

**Requirements:**
1. `app/layout.tsx`: `metadataBase = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? \`https://${siteConfig.domain}\`)`;
   default `openGraph: { siteName, locale, type: "website" }`, `twitter: { card: "summary_large_image" }`,
   `alternates.canonical` on every page (absolute via metadataBase). Add `app/icon.svg` drawn
   from `siteConfig.theme` colours and `siteConfig.shortName`, and `app/opengraph-image.tsx`
   (ImageResponse) rendering `siteConfig.name` + tagline in theme colours. No niche strings.
2. `generateMetadata` in the catch-all covers every result kind: listing (title
   `"{name} — {Singular} in {City}"`, description from the rendered excerpt, canonical
   `/{city}/{slug}`), pillar (page N gets canonical `${basePath}/page/${n}` and description suffixed
   "— page N"), 404 → `{}`. Category pages likewise. Titles must NOT include the site name (the
   layout template adds it). Fix `/pricing` title to `"Pricing"`. Home keeps its absolute title.
3. Fix `/pricing`: move the interval to the path (`/pricing` = annual default, `/pricing/monthly`)
   so the page is static again, or drop `revalidate` and the misleading comment — choose the path
   variant; `IntervalToggle` links become real `<a href>`.
4. `navigation.ts`: contentHub → `/blog` (label from config); add a test that every href in
   `sitemapRoutes()`/`navRoutes()`/`footerRoutes()` maps to an existing `app/**/page.tsx` or
   `route.ts` (resolve `[...x]` catch-alls as matching anything).
5. `ListingDetail`: replace `/claim/{slug}` with a `mailto:` to `siteConfig.supportEmail` with a
   pre-filled subject ("Claim {name}") and `/report/{id}` likewise ("Report {name}") until those
   routes ship; render report/remove links on every listing regardless of claim status. Pass the
   schema builder exactly what is rendered: `description` = displayed text (excerpt for free),
   `sameAs` only when `tier.showSocial`, omit `email` and `priceRange` entirely (not rendered).
6. `PillarPage`: heading count = the scope's own total (already computed at
   `[...segments]/page.tsx:140`), noun = category name on category scopes; ItemList item URLs use
   `cityPath` (as `PillarPage.tsx:78` already does). `pillarSchema` on page N uses the page-N URL
   for `url`/`@id`.
7. Visible breadcrumb `<nav aria-label="Breadcrumb">` on `/categories`, `/cities`, `/blog`,
   `/blog/[slug]` wherever `BreadcrumbList` is emitted (reuse the pillar page's markup).
8. Sitemap: use `generateSitemaps()` sharded as `static+cities`, `categories`, `listings-<n>`
   (5,000 per shard); blog posts included with `lastModified` from frontmatter; categories only
   when they have ≥1 published listing (share the rule with the category page via one query
   helper); static routes omit `lastModified`. `lib/db/queries/sitemap.ts` functions take a
   `viewer`. Update `e2e/sitemap.spec.ts` expectations if the index format changes (that file is
   yours for this task).
9. Blog: reject `^//` in `SAFE_HREF`; demote body headings one level (`#` → `<h2>`).
10. `app/trust/page.tsx:55-59`: neutral wording (no trades-flavoured copy).

**Tests:** `lib/schema/builders.test.ts` (tier-gated fields, page-N ids), `navigation.test.ts`
(route existence), `sitemap.test.ts`, `lib/blog/posts.test.ts` (`//` and heading level). Verify
titles/canonicals by building and curling `/`, a pillar, a listing, `/pricing`, `/categories/x`;
paste the `<title>`/`<link rel=canonical>` lines into your report.

---

## Task 5: Indexing gate, query hygiene, importer, worker, media, indexes

**Owns:** `lib/db/queries/cities.ts`, `listings.ts`, `category-page.ts`, `indexes.ts`,
`homepage.ts`, `search.ts`, `listing-detail.ts` (published base + projection only), `viewer.ts`,
`sort.ts`, `client.ts`, `lib/db/queries/indexing.ts` (new), `lib/db/schema/**`,
`drizzle/**` (new migration), `lib/import/**`, `worker/**` (except the env-validation line at the
top of `worker/index.ts`, owned by Task 1), `lib/media/**`, `test/factories.ts`, `test/db.ts`,
`scripts/seed.ts` **only** to call the new indexability helper.

**Problems (verified):**
- Nothing outside `seed.ts` writes `cities.listing_count`/`is_indexable`; `importRows`,
  `createSubmission` and approval never touch them, so the gate can never open.
- `pillarHeading` (`cities.ts:64-71`) hard-codes `isIndexable: true, listingCount: 0` for vertical
  scope (constraint 9 bypass); city-category scope inherits the city's flag (`cities.ts:39-46`);
  never checks `cities.isPublished` / `areas.isPublished` / `verticals.isActive`.
- Published gate re-implemented in 8 places (`listings.ts:18`, `category-page.ts:23`,
  `indexes.ts:69,106`, `listing-detail.ts:29,58`, `homepage.ts:86`, `search.ts:37`,
  `sitemap.ts:48` — sitemap is Task 4's; export the helper and tell them the name in your report).
- `nearbyCities` (`indexes.ts:126`) and all of `guardrails.ts` take no viewer.
- Public reads return the full row including `submittedByEmail`, `customFields.submission`
  (submitter email + IP), `verificationChecks`, `rejectedReason`.
- `TestDb` from `test/db.ts` is used as the production handle type; `db as never` everywhere.
- `assertUploadable`/`sniffMime` (`lib/media/validate.ts`) have no callers outside tests;
  `presignPut` (`lib/media/r2.ts:38`) signs an unconstrained PUT. Constraint 15 unenforced.
- `worker/lock.ts:24-33` uses session advisory locks over a `max: 10` pool.
- `worker/jobs/derivatives.ts:34-36` retries a failing image every minute forever.
- Importer (`guardrails.ts:97-99`) resolves city by name only (Richmond/Newport ambiguity);
  suppression check skipped when postcode absent (`:47-48`); duplicate match is case-sensitive
  while suppression is normalised.
- Missing indexes: `listings(area_id, status)`; partial `listings(status) WHERE tier='premium'`;
  `listings(lower(name), postcode)`; expression index on digits-only phone; `cities(lower(name))`.

**Requirements:**
1. `lib/db/client.ts` exports `type Db`; `test/db.ts` re-exports `TestDb = Db`; remove
   `db as never` casts in files you own (others will follow).
2. One `publishedListings(viewer)` in `listings.ts` (admin viewer sees all statuses); every public
   query in your files uses it. Add `viewer` to `nearbyCities` and the importer functions.
3. `publicListingColumns` projection used by every non-admin read; a test asserts the public
   result has no `submittedByEmail`, `verificationChecks`, `rejectedReason`, or
   `customFields.submission`.
4. `lib/db/queries/indexing.ts`: `recomputeCityIndexability(db, viewer, cityId)` sets
   `listing_count` = published count and `is_indexable` = `count >= siteConfig.seo.minListingsToIndex && intro_html IS NOT NULL`
   (respect `seo.requireIntroCopyToIndex`). Call it from `importRows` and from the seed after
   listings load. Export a `scopeIndexability(db, viewer, scope)` used by `pillarHeading` so every
   scope (city, city-category, vertical, area) computes its own flag from its own count; remove
   the hard-coded vertical values; return `null` for unpublished cities/areas/inactive verticals.
5. Media: worker calls `assertUploadable(buffer, { allow: LISTING_IMAGE_TYPES })` before
   `generateDerivatives`; on rejection delete the object and mark the row failed. Replace
   `presignPut` with a presigned POST policy (`@aws-sdk/s3-presigned-post`, add the dependency)
   with `content-length-range` 1..8 MB and a `Content-Type` starts-with condition.
6. Worker lock: run each job inside `db.transaction()` with `pg_try_advisory_xact_lock`, or give the
   worker its own `postgres(url, { max: 1 })` client — pick one and test that two concurrent runs
   of the same job name serialise.
7. Derivatives: add `derivatives_attempts int default 0` and `derivatives_error text` to
   `listing_images`; skip rows with attempts ≥ 5; record the error. Migration via `pnpm db:generate`.
8. Importer: `ImportRow` gains optional `region`; resolve city via one helper that throws on
   ambiguity; suppression check runs on name+phone+email when postcode absent; duplicate match uses
   `lower(trim(name))` and normalised postcode in SQL.
9. Indexes listed above in the same migration. Migrate `directory_test` and `directory_dev`.

**Tests:** `withTestDb` tests for indexability (gate opens at exactly `minListingsToIndex`, stays
closed without intro copy), scope indexability per scope kind, projection, importer ambiguity,
suppression without postcode, lock serialisation, media rejection path (mock R2).

---

## Task 6: Site chrome, error pages, legal pages, fonts, styling

**Owns:** `components/layout/**` (new: `SiteHeader.tsx`, `SiteFooter.tsx`, `Container.tsx`),
`app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/privacy/page.tsx`,
`app/terms/page.tsx` (new), `app/globals.css`, `lib/theme.ts` + test, `components/pillar/ListingCard.tsx`,
`components/pillar/Pagination.tsx`, `components/home/**`, `components/pricing/**` (styling only —
Task 4 changes the interval links; keep your change to classes), `components/blog/PostCard.tsx`,
`components/blog/PostBody.tsx` (classes only), `config/types.ts` + `config/site.config.ts`
**append-only** (a `legal` block: `privacyLastUpdated`, `termsLastUpdated`, `dataController`), and
**`app/layout.tsx` body only** (wrap children in header/footer — Task 4 edits the `metadata`
export in the same file; keep your edit to the JSX).

**Problems (verified):** no header/nav/footer anywhere (`navRoutes()`/`footerRoutes()` have zero
callers); no `not-found.tsx`/`error.tsx`/`global-error.tsx`; no `/privacy`, `/terms`; fonts
Fraunces/Inter named in the theme but never loaded; 16 `className` usages in the whole app —
pages render as unstyled HTML; `Pagination.tsx:35` renders every page number 1..N.

**Requirements:**
1. `SiteHeader` (logo text from `siteConfig.name`, nav from `navRoutes()`, search link, "Add your
   {singular}" CTA) and `SiteFooter` (columns from `footerRoutes()`, legal links, `legalEntity`
   line, © year via `lib/clock.ts` `now()`), rendered in the root layout. Mobile: a no-JS
   disclosure menu (`<details>`) — no client component needed.
2. `not-found.tsx` and `error.tsx` render inside the chrome with links to `/cities`,
   `/categories`, `/search`; `global-error.tsx` is self-contained. Copy uses `siteConfig.entity`.
3. `/privacy` and `/terms`: structured pages whose facts come from `siteConfig` (`legalEntity`,
   `supportEmail`, `domain`, `country`) and the new `legal` block; clearly marked template
   sections ("[Confirm with counsel]") rather than invented legal claims. Add both to
   `buildRoutes` in `lib/features/navigation.ts`? No — that file is Task 4's. Instead export
   `LEGAL_ROUTES` from `components/layout/legal-routes.ts` and use it in the footer; Task 4's
   route-existence test will pick them up on merge.
4. Fonts: `next/font/google` in `app/layout.tsx` for the two families named in
   `siteConfig.theme.fontHeading/fontBody`. `next/font` needs literal imports, so implement a
   small map in `lib/fonts.ts` for the families the config type allows (add a union type
   `FontFamily = "Fraunces" | "Inter" | "Playfair Display" | "Source Sans 3" | "DM Sans" | "Lora"`
   to `config/types.ts`) and set the CSS variables from the loaded font objects; fall back to the
   existing system stacks.
5. Styling pass with Tailwind 4 utilities and the theme tokens (`bg-primary`, `text-accent`,
   `rounded-[var(--radius-token)]`): container widths, type scale, header/footer, listing cards
   (grid, image placeholder, badge, tier accent), pillar page blocks, listing detail two-column
   layout with the enquiry form as a card, forms (inputs, labels, errors, buttons), pricing cards,
   blog cards/body, home hero + search. Keep every existing `data-testid`, id, name and text
   that the e2e suite selects on. No new client components for styling.
6. `Pagination`: window to first/last ±2 with ellipses; keep prev/next; every link remains a real
   `<a href>` (constraint 12); `rel="prev"/"next"` on the anchors.
7. Accessibility: visible `:focus-visible` outline on all interactive elements; colour contrast
   ≥ 4.5:1 for body text on theme colours (compute from `siteConfig.theme.primary` — provide
   `lib/theme.ts` `readableOn(hex)` returning black/white, tested).

**Tests:** `lib/theme.test.ts` (`readableOn`, font var mapping); `pnpm build:flags-off` passes;
run the existing e2e suite (`corepack pnpm test:e2e`) and paste the summary line in the report;
take screenshots of `/`, a pillar, a listing, `/pricing`, `/add-listing`, 404 with Playwright
(`page.screenshot`) into `.superpowers/sdd/screens/` and list them.

---

## Task 7: Email, notifications and the jobs queue

**Owns:** `lib/email/**` (new), `lib/db/queries/jobs.ts` (new) + test, `worker/jobs/notify.ts`
(new), `package.json` (add `resend` + `@react-email/components`? — no: plain HTML strings, add
only `resend`), `pnpm-lock.yaml`, and **append-only** hooks in `lib/actions/enquiry.ts` and
`lib/actions/submit-listing.ts` (one call each to enqueue a job after the DB write — Task 2 is
rewriting those files; put your hook in a separate exported function `notifyEnquiry(...)` /
`notifySubmission(...)` in `lib/email/notify.ts` and add a single call line, so the merge is
trivial), `worker/index.ts` (register the job — one line).

**Problems (verified):** enquiries are stored and `enquiryCount` bumped but nobody is notified
(`lib/actions/enquiry.ts:100`); submissions likewise; `RESEND_API_KEY`, `EMAIL_FROM`,
`ADMIN_NOTIFICATION_EMAIL` are demanded but `resend` is not installed and no mail module exists.

**Requirements:**
1. `lib/email/sender.ts`: `sendEmail({ to, subject, html, text, replyTo })` via Resend; when
   `RESEND_API_KEY` is unset log and return `{ sent: false, reason: "not-configured" }` (never
   throw in the request path). Strip CR/LF from every header field. Tests with a mocked Resend.
2. `lib/email/templates/*.ts`: `enquiryToOwner`, `enquiryToAdmin`, `submissionToAdmin`,
   `submissionReceived` (to submitter) — plain HTML + text, every string built from
   `siteConfig` (name, entity nouns, supportEmail). No niche strings.
3. Jobs: use the existing `jobs` table in `lib/db/schema/ops.ts` if present (read it); otherwise
   add a minimal one via migration — coordinate: Task 5 also adds a migration; name yours
   `0002_*` by running `pnpm db:generate` after pulling nothing (just accept the next number and
   note in the report that the journal may need renumbering on merge). `enqueueJob(db, viewer, { kind, payload, runAfter })`,
   `claimNextJob`, `completeJob`, `failJob` (attempts, last error, max 5).
4. `worker/jobs/notify.ts` processes `notify.enquiry` and `notify.submission` jobs: loads the
   listing/submission through `lib/db/queries` with `ADMIN_VIEWER` (read `lib/db/viewer.ts`),
   sends owner email only when the listing is claimed and has an owner email, always sends admin
   email to `ADMIN_NOTIFICATION_EMAIL`. Register it in `worker/index.ts` on a 30 s tick.
5. Actions enqueue the job inside the same transaction as the write (one added line each).

**Tests:** sender (mocked), templates (snapshot-free assertions that the entity nouns and
site name appear and no `undefined`), jobs queue (`withTestDb`: enqueue → claim → complete;
fail increments attempts; sixth failure parks it), notify job (mock sender, real DB).

---

## Task 8: Tooling, seed quality, config guards, e2e and CI

**Owns:** `scripts/check-niche-strings.sh`, `scripts/seed.ts` (**except** the indexability call
Task 5 adds — add yours as separate lines), `scripts/seed.test.ts`, `scripts/seed-cli.ts`,
`seeds/**`, `content/blog/**`, `lib/blog/demo.ts` (new), `.github/workflows/ci.yml`,
`playwright.config.ts`, `e2e/routes.spec.ts` (new), `e2e/canonical.spec.ts` (new),
`e2e/jsonld-types.spec.ts` (new), `e2e/chrome.spec.ts` (new), `README.md` (Status line and
Layout section only).

**Problems (verified):**
- `check-niche-strings.sh:14` drops any *line* containing `siteConfig`, so
  `` `${siteConfig.name} wedding venues` `` passes; `scripts/` and `content/` are not scanned;
  `seed-cli.ts:8` defaults to `"wedding-venues"`.
- Seed: `parseCsv` yields `""` for missing cells so `row["region"] ?? null` never nulls
  (`seed.ts:69`) → `/cities` renders an empty `<h2>`; listing descriptions name a different city
  than the listing's city; Richmond has 31 listings while 11 cities have one; seeded cities carry
  `<p>Intro copy.</p>` as intro copy (find where — it is not in `seed.ts`; check the CSVs, the
  factories, and the dev DB — and make the seed write real per-city intro copy generated from
  the city name, region and `siteConfig.entity`, ≥ 2 sentences, so the gate is met honestly).
- Three wedding-specific blog posts ship with every clone.
- CI: e2e job runs only the configured flags; the flags-off/on builds are never exercised by
  Playwright. Playwright starts `next start` which warns it "does not work with output:
  standalone".
- e2e gaps: nothing asserts every `sitemapRoutes()` href resolves, canonical starts with
  `NEXT_PUBLIC_SITE_URL`, per-page-type JSON-LD `@type`, header/footer present, 404 page renders
  in chrome.

**Requirements:**
1. `check-niche-strings.sh`: strip `siteConfig\.[A-Za-z.]+` tokens with `sed` before matching
   instead of dropping the line; scan `scripts/` and `content/` too (content is exempt only under
   `content/blog/demo/` — see 4); fail with the offending lines.
2. Seed: `region || null`; descriptions reference the listing's own city and category; distribute
   listings so every city has ≥ `minListingsToIndex` except three deliberately thin ones (to
   exercise the gate); generate intro copy per city from config (no niche literals in the
   script — nouns from `siteConfig.entity`). Default niche in `seed-cli.ts` derived from
   `siteConfig.entity.plural` slug. Re-seed `directory_dev` is NOT allowed (shared) — instead add
   `scripts/reseed-dev.sh` that drops and recreates `directory_dev`, and note in the report that
   the controller must run it after merge.
3. `playwright.config.ts`: run the standalone server
   (`node .next/standalone/server.js` after copying `.next/static` and `public` into
   `.next/standalone/` — do the copy in the `webServer.command`), honour
   `SITE_FLAGS_OVERRIDE` from the environment in `SERVER_ENV`.
4. Blog demo content: move the three posts to `content/blog/demo/`; `lib/blog/demo.ts` exposes
   `includeDemoPosts()` = `process.env.NEXT_PUBLIC_DEMO_MODE === "true"`; the posts loader
   (`lib/blog/posts.ts` is Task 4's — do not edit it; instead have your `demo.ts` export the
   directory list and tell Task 4's owner in your report that `posts.ts` should read from
   `postDirectories()`; the controller will wire it on merge). Set `NEXT_PUBLIC_DEMO_MODE=true`
   in `playwright.config.ts` `SERVER_ENV` and in CI so e2e keeps its blog fixtures.
5. CI: matrix the e2e job over `SITE_FLAGS_OVERRIDE: [off, on]`; cache pnpm store and Playwright
   browsers; add a `docker-build` job that builds the runner image (`docker build --target runner`)
   so Dockerfile breakage fails CI.
6. New e2e specs: `routes.spec.ts` (every `sitemapRoutes()`/`navRoutes()`/`footerRoutes()` href
   → 200), `canonical.spec.ts` (`link[rel=canonical]` on `/`, pillar, listing, `/pricing`,
   `/categories/<x>` is absolute and starts with the base URL), `jsonld-types.spec.ts` (`@type`
   present per page type: `CollectionPage`+`ItemList`+`BreadcrumbList` on pillar/category,
   `EventVenue`-or-`siteConfig.schema.listingType` on listing, `BlogPosting` on a post),
   `chrome.spec.ts` (header nav + footer present on every page type; 404 page shows the header).
   These will fail until Tasks 3/4/6 merge — mark them `test.fixme()` with a comment naming the
   task, and the controller flips them on after merge.

**Tests:** `scripts/seed.test.ts` (region null, distribution, intro copy present, no niche
literals), `check:strings` green, `pnpm test`.

---

## Task 9: The clone wizard

**Owns:** `scripts/new-site.ts` (new), `scripts/new-site.test.ts`, `lib/clone/**` (new:
question schema, config writer, seed scaffolder), `docs/CLONING.md` (new), `package.json` script
`"new-site": "tsx scripts/new-site.ts"` (append-only), `seeds/_template/**` (new).

**Goal (the reason the platform exists):** "ask questions, then build the directory from the
answers". Today a clone is hand-editing `config/site.config.ts`, hand-writing three CSVs, replacing
blog posts and setting ~20 env vars.

**Requirements:**
1. `lib/clone/questions.ts`: a typed list of questions, each with `key`, `prompt`, `type`
   (`text | choice | number | boolean | list | colour`), `default`, `validate`, and `when`
   (conditional on earlier answers). Cover: site name, short name, domain, tagline, legal entity,
   support email, entity nouns (singular/plural/capitalised/verb/owner noun), country (from
   `SUPPORTED_COUNTRIES` in `lib/geo/countries.ts` → locale/currency/timezone/regionLabel
   defaults from the country profile), site mode, schema.org listing type (choice list of common
   types + free text), theme (primary/accent/fonts from the `FontFamily` union/radius), custom
   fields (repeatable: key/label/type/searchable/showInCard/tier), review criteria, tiers (prices
   annual/monthly with the "annual = 10 × monthly" rule offered as default, trial days, max
   images), feature flags (each with a one-line description), SEO thresholds, and where the seed
   data comes from (`csv` path | `template` | `skip`).
2. `lib/clone/write-config.ts`: renders `config/site.config.ts` from the answers (pretty,
   commented, `as const satisfies SiteConfig`), runs the same validators the build runs
   (`validateFeatureDependencies`, `validateCountry`) and refuses to write on failure.
3. `lib/clone/scaffold-seed.ts`: writes `seeds/<niche>/{cities,categories,listings}.csv` from a
   template (headers + 3 example rows using the entity nouns) unless the user supplied CSV paths,
   in which case it validates headers and copies them.
4. `scripts/new-site.ts`: interactive CLI using `node:readline/promises` (no new prompt
   dependency), `--answers answers.json` for non-interactive runs, `--dry-run` printing the config
   it would write. Also writes `.env` from `.env.example` with `NEXT_PUBLIC_SITE_URL` and
   `SITE_ENV` filled, removes `content/blog/demo` unless `--keep-demo`, and prints the exact next
   commands (`db:up`, `db:migrate`, `seed <niche>`, `dev`).
5. `docs/CLONING.md`: the under-4-hours runbook: questions, seed CSV format, env vars by phase,
   Coolify steps (volume for `STATIC_ASSETS_DIR`, pre-deploy migrate), DNS, the indexing gate,
   and the legal checklist (legalEntity, privacy/terms review, data-sources page).

**Tests:** `scripts/new-site.test.ts` runs the wizard with `--answers` fixtures for a GB
niche-national site and a US local-multi-vertical site into a temp dir, then asserts the generated
config type-checks (import it with `tsx` in a child process), validators pass, CSV headers match
the seed loader's expectations, and a wrong country/currency pair is refused.
