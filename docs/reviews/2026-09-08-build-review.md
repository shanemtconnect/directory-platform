# Build review — 2026-09-08

Scope: full repo at commit 5040790 (Phase 1 done, Phase 2 partly built). Three parallel
code reviews (routing/DB, pages/SEO, forms/infra) plus a live run of the production build.

## What passes

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm check:strings` | clean |
| `pnpm test` | 415 / 415 |
| `pnpm build:flags-off` and `build:flags-on` | both pass |
| `pnpm test:e2e` (Playwright, 23 tests) | 23 / 23 |
| Lighthouse (mobile) on `/richmond-north-yorkshire` | SEO 100, A11y 100, Best practices 100 |

## The gap between the goal and the build

The stated goal is "ask questions, then build the directory from the answers". Nothing does
that yet. Today a clone is: hand-edit `config/site.config.ts`, hand-write three CSVs in
`seeds/<niche>/`, replace `content/blog/*.mdx`, set ~20 env vars. The master plan puts the
question-driven generator (`scripts/new-site.ts` + `docs/CLONING.md`) in Phase 8. Nothing
validates a config beyond country/currency/flags — `legalEntity: "TBC"` and
`supportEmail: hello@example.co.uk` would ship.

## P0 — fix before anything is deployed

1. **Master plan is in the public repo's git history.** Commit `aa903c2` added
   `docs/superpowers/plans/2026-09-07-directory-platform-master.md` (pricing, competitor
   benchmarks, DMCC risk assessment, scraped-data legal exposure); `cb6db69` deleted it and
   gitignored it, but all three commits are on `origin/main`. Fix: `git filter-repo` the path
   out of history and force-push, or make the repo private. Shane's call.
2. **ISR cache serves HTML pointing at dead assets after every rebuild.** Redis keys are
   `nextjs:/durham` with no build id (`cache-handler.mjs:44`). Observed live: cached homepage
   linked `/_next/static/chunks/1i8exnwvl15km.css`, which 404s on the current build, so the page
   rendered unstyled. The Phase 0 "cache survives redeploy" goal only holds if old
   `.next/static` is retained across deploys (CDN/R2 with `assetPrefix`, never deleted). Otherwise
   prefix the key with `BUILD_ID` and accept a cold cache per deploy.
3. **Docker image cannot build or boot as written.** `Dockerfile:28` copies `public/` which does
   not exist; `Dockerfile:37-38` copies pnpm symlinks for `@fortedigital`/`@redis` (dangling in the
   image, so the app silently falls back to LRU — the exact failure the comment says it prevents);
   worker runs `node --experimental-strip-types worker/index.ts` but `worker/index.ts:2` imports
   `@/lib/db/client`, which Node cannot resolve. Fix: add `public/.gitkeep`, `pnpm deploy --prod`
   for the runner, run the worker with `tsx`.
4. **Runtime env validation is dead code.** `validateEnv(..., {phase:"runtime"})` has no callers;
   only the build phase runs in `next.config.ts:9`. README and `.env.example` claim it fails the
   boot. Fix: `instrumentation.ts` `register()` → `validateEnv(process.env, {phase:"runtime"})`,
   and the same at the top of `worker/index.ts`.
5. **Anti-abuse fails open on every axis.** `lib/spam/turnstile.ts:20-39` skips when the secret is
   unset and passes on fetch error; `lib/spam/rate-limit.ts:47,62` fails open when Redis is down
   and re-connects per call (3 s+ per submit); rate-limit key is the *first* `X-Forwarded-For`
   entry (`lib/actions/enquiry.ts:55`, `submit-listing.ts:169`), which the client controls. And
   `components/listing/EnquiryForm.tsx` never renders `TurnstileWidget`, so with the secret set
   every enquiry fails "couldn't verify you're human". Fix: fail closed in production, read the
   last XFF hop, add the widget to the enquiry form.

## P1 — SEO and routing (will show in GSC as soon as crawled)

6. **Listing detail pages have no metadata.** `app/[...segments]/page.tsx:194-197` returns `{}`
   for anything that isn't a pillar. Verified: `/truro/the-grange-estate` title is just the site
   name, description is the site tagline. Listings are most of the URL space.
7. **No `metadataBase`, no canonicals on pillar/listing/category/home, no OG tags, no favicon.**
   Relative canonicals on `/pricing`, `/blog/*`, `/advertise` render as `href="/pricing"`
   (`app/layout.tsx:8`). Every page shares the tagline as description.
8. **Four links 404 out of the box.** Sitemap and nav advertise `/guides`
   (`lib/features/navigation.ts:43`) but the route is `/blog`; `ListingDetail.tsx:80-81` links
   `/claim/{slug}` and `/report/{id}` which don't exist; ItemList URLs on `/city/category` pillars
   are `/city/category/slug` (`[...segments]/page.tsx:161`) which resolve 404.
9. **Duplicate-content / soft-404 holes, all verified 200:** `/leeds/page/999`, `/Leeds`,
   `/leeds/page/1`, `/leeds/page/1e0`, `/truro/the-grange-estate/page/3`. Fixes: bound page to
   `totalPages`, strict `^[1-9]\d*$` parse, 301 uppercase → lowercase, 301 `/page/1` → base,
   reject `/page/N` on listing results.
10. **Slug renames break child URLs and leave stale links.** `reallocateSlug`
    (`lib/routing/slugs.ts:153-171`) writes one redirect for the renamed path only, so
    `/old-city/<listing>` 404s (constraint 24), and it never updates the entity's own `slug`
    column, so sitemap/homepage/category links keep emitting the old URL. Non-301 status codes
    become 307s (`[...segments]/page.tsx:89-91`), so 410 is impossible.
11. **Indexing gate (constraint 12) has no maintainer and is bypassed in two places.** Nothing
    outside `seed.ts` writes `listing_count`/`is_indexable`; vertical scope hard-codes
    `isIndexable: true` (`lib/db/queries/cities.ts:64-71`); city-category scope inherits the
    city's flag so a one-listing category page in an indexable city is indexed. `pillarHeading`
    also never checks `isPublished`, so unpublished cities render 200. Seeded cities currently
    carry `<p>Intro copy.</p>` as intro_html, so the gate is met with filler on 38/50 cities.
12. **Sitemap:** single flat file (plan says split index; breaks at 50k), blog posts absent,
    zero-listing categories listed though the page noindexes them, static routes get
    `lastModified: now` on every fetch.
13. **JSON-LD ≠ visible content (constraint 14).** Listing schema emits email, full description,
    priceRange and socials regardless of tier (`lib/schema/builders.ts:90-109`); BreadcrumbList on
    `/categories`, `/cities`, `/blog` with no visible breadcrumb; `/x/page/2` asserts page 1's
    `@id`. `/pricing` title renders "Pricing — Which Wedding Venue | Which Wedding Venue" and
    reads `searchParams` so its `revalidate = 3600` is dead (route is dynamic — confirmed in the
    build table).

## P1 — data and security

14. `findDuplicate` (`lib/db/queries/submissions.ts:130-153`) has no status filter: anyone can
    type a phone number and learn the name/slug of pending or removed listings.
15. `assertUploadable`/`sniffMime` (`lib/media/validate.ts`) have no callers outside tests, and
    `presignPut` (`lib/media/r2.ts:38`) signs an unconstrained PUT. Constraint 22 (magic bytes,
    8 MB cap) is enforced nowhere.
16. `worker/lock.ts:24-33` uses session-scoped advisory locks over a `max: 10` pool, so unlock
    can land on a different connection and the lock sticks until restart.
17. Query rows returned to `PUBLIC_VIEWER` include `submittedByEmail`, submitter IP in
    `customFields.submission`, `verificationChecks`, `rejectedReason` (`listings.ts:54`,
    `listing-detail.ts:22`, `search.ts:91`). Not rendered today, but every new consumer inherits it.
18. Constraint 9/10 drift: no viewer on `sitemap.ts`, `indexes.ts:126`, `submissions.ts`,
    `guardrails.ts`; the published gate is re-implemented in 8 places instead of one
    `publishedListings()`; direct Drizzle in `app/badge/[id]/route.ts`, `advertise/badge/page.tsx`,
    `lib/actions/enquiry.ts`.
19. `allocateSlug` is check-then-insert (`slugs.ts:78-87`): concurrent same-name submissions
    abort the whole transaction on 23505 instead of taking the next candidate.
20. Importer resolves city by name only (`guardrails.ts:97-99`) — Richmond/Newport land on
    whichever row comes first; suppression check is skipped when postcode is absent; duplicate
    match is case-sensitive while suppression is normalised.

## Unfinished (visible to a visitor)

- No header, nav or footer anywhere; `navRoutes()`/`footerRoutes()` have zero callers.
- No `not-found.tsx`, `error.tsx`, `global-error.tsx`; no `/privacy`, `/terms`.
- Almost no styling: 16 `className` usages in the whole app; Fraunces/Inter are named in the
  theme but never loaded, so every clone renders Georgia/system-ui.
- Enquiries and submissions are stored but nobody is notified; `resend`, `better-auth` and a
  PayPal SDK are not installed although their env vars are "required".
- Three wedding-specific blog posts ship with every clone and `check-niche-strings.sh` does not
  scan `content/`; seed default `"wedding-venues"` in `seed-cli.ts:8`.
- Seed data: listing descriptions name a different city than the listing's city; region stored
  as `""` not null (`seed.ts:69`) so `/cities` renders an empty `<h2>`; Richmond has 31 listings.
- Failed image derivatives retry every minute forever (`worker/jobs/derivatives.ts:34`).
- Pagination renders every page number 1..N (`Pagination.tsx:35`).
- e2e does not cover: every `sitemapRoutes()` href resolving, canonical base, per-page-type
  JSON-LD `@type`, flags-off build.

## Missing indexes

`listings(area_id, status)`; partial `listings(status) where tier='premium'`;
`listings(name, postcode)` and expression index on digits-only phone for the importer;
`cities(lower(name))`.

## Suggested order

1. P0 items 1–5 (about 2 days).
2. Metadata layer: `metadataBase`, `generateMetadata` for listings, canonicals, OG, icon (1 day).
3. Routing holes 8–10 and the indexing-gate maintainer 11 (2 days).
4. Site chrome: header/footer/404/error, fonts, real styling (this is most of Phase 2's
   remaining time).
5. Then the question-driven clone wizard — which is the actual goal, and is Phase 8 in the plan.
