# Task 2 — Anti-abuse and server-action hardening

**Worktree:** `/Users/shanemt/Claude/projects/directory-platform/.claude/worktrees/agent-a772f4ac0c859575e`
**Branch:** `worktree-agent-a772f4ac0c859575e` (cut from `review-fixes`)
**Status:** DONE_WITH_CONCERNS

## Commits

| SHA | Subject |
| --- | --- |
| `bbc6dcb` | fix(spam): fail closed on Turnstile misconfiguration and outages |
| `0a6e54d` | fix(spam): trust only the last XFF hop and count in process when Redis is down |
| `448a803` | fix(actions): validate before spending a Turnstile token or a rate-limit slot |
| `ec209d4` | feat(db): move the badge lookups behind a viewer-gated query |
| `bb5967d` | feat(db): move the enquiry insert behind a viewer-gated query |
| `96f1d49` | fix(submit): stop the duplicate check leaking unpublished listings |
| `6b3e056` | fix(turnstile): render explicitly, reset after an error, and show it on enquiries |
| `b3ee877` | test(e2e): give the suite Turnstile testing keys |

Nothing pushed. No other worktree touched.

## Baseline

`corepack pnpm install --frozen-lockfile` completed (it exits non-zero on
`ERR_PNPM_IGNORED_BUILDS` for esbuild; dependencies are installed and
everything runs).

Baseline on the branch as cut: **463 tests**, of which 3 failed —
`lib/routing/resolve.test.ts` and `lib/routing/slugs.test.ts` timed out at
5000 ms. Both pass in isolation; the cause is contention on the shared
`directory_test` database from the parallel workers, not this branch.
`pnpm typecheck` was clean.

Final: **514 tests, 41 files, all passing**, typecheck clean,
`pnpm check:strings` clean, `pnpm build` succeeds.

## What was implemented

### 1. Turnstile fails closed (`lib/spam/turnstile.ts`)

- No secret → skip **only** when `process.env.NODE_ENV !== "production"`. In
  production with no secret: `{ ok: false, skipped: false, reason: "not-configured" }`,
  and one `console.error`, latched by module state so a misconfigured deploy
  does not log per submission.
- `signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS)` (5000, exported so the
  test can assert the value rather than restate it).
- Any fetch rejection — network error or timeout — returns
  `{ ok: false, reason: "unreachable" }`. The previous code returned
  `{ ok: true, skipped: true }`, i.e. a Cloudflare outage disabled the check.
- Both actions already surfaced "We couldn't verify that you're human." for
  `!ok`; that path now actually fires.

### 2. Client IP and rate limiting (`lib/spam/client-ip.ts`, `lib/spam/rate-limit.ts`)

- New `clientIp(headers)`: **last** `X-Forwarded-For` hop (the one our own
  proxy appended), else `X-Real-IP`, else `null`. Empty entries and
  whitespace are discarded.
- New `rateLimitSubject(ip)`: returns the IP, or `anon:${randomUUID()}` when
  null — never a shared `"unknown"` bucket.
- `rateLimit` no longer fails open. When Redis is unreachable it counts in an
  in-process `Map` with the same limit and window, sweeping expired entries on
  write so the map cannot grow without bound.
- A failed connect sets a 30 s cooldown (`REDIS_RETRY_COOLDOWN_MS`), so one
  dead cache no longer costs a 3 s connect timeout on every submit. A
  successful connect clears it.

### 3. Action ordering, uuid and CR/LF (`lib/actions/validation.ts` + both actions)

- Order in both actions is now honeypot → **validate → rate-limit → Turnstile
  → DB**. A single-use Turnstile token is no longer spent, and a rate-limit
  slot no longer consumed, by a submission that fails on a typo.
- `isUuid` uses the brief's pattern verbatim. `listingId` and `categoryId` are
  shape-checked before they reach a uuid column; both return a field error
  instead of letting Postgres raise `invalid input syntax for type uuid` out
  of the action. `submitEnquiry` also sets a generic `message` for the
  `listingId` case, since that field is hidden and its error has nowhere to
  render.
- `stripCrlf` collapses `[\r\n]+` to a single space on **every** string field
  at read time.
- The validators were moved out of the `"use server"` modules into
  `lib/actions/validation.ts`: a `"use server"` file may only export async
  functions, which is why they had no tests. 17 unit tests cover them.

### 4. Turnstile widget (`components/submit/TurnstileWidget.tsx`, `EnquiryForm`, `ListingDetail`)

- `EnquiryForm` now takes a required `turnstileSiteKey` prop and renders the
  widget. Previously it never did, so with a secret configured **every**
  production enquiry would have been rejected for a missing token.
  The prop is required on purpose: a merge that drops it fails typecheck.
- `ListingDetail` passes `process.env.TURNSTILE_SITE_KEY?.trim() || null` —
  one prop on the existing `<EnquiryForm>` call, nothing else touched, so the
  Task 4 JSON-LD merge stays trivial. (`?.trim() || null` rather than the
  brief's literal `?? null`, to match `app/add-listing/page.tsx` and to treat
  a whitespace-only value as unset exactly as `verifyTurnstile` does.)
- The widget uses **explicit rendering**: `api.js?render=explicit&onload=onloadTurnstileCallback`,
  a module-level queue drained by the global onload callback, and
  `window.turnstile.render(el, { sitekey, callback, … })`. The old implicit
  mode only scanned the page when the script first loaded, so after a
  client-side navigation the widget never appeared at all.
- `remove(widgetId)` on unmount; `reset(widgetId)` whenever `resetOn` changes
  identity (both forms pass the `useActionState` state), because a token is
  single use and without a reset every retry after an error failed.
- The token is exposed through a hidden `cf-turnstile-response` input that the
  component owns, with Turnstile's own `response-field: false`, so the form
  holds exactly one field of that name and `FormData.get` cannot pick up an
  empty duplicate.

### 5. Duplicate visibility (`lib/db/queries/submissions.ts`)

- `findSubmissionDuplicate(tx, viewer, input)`. `DuplicateMatch` is now a
  union: `{ kind: "match", listingId, name, slug, citySlug, reason }` or
  `{ kind: "pending" }`. Any non-published match is reported to a non-admin as
  `pending` — no name, no slug. Previously the public form doubled as a lookup
  tool: type a phone number, read back the name and slug of a pending or
  removed listing.
- The action's duplicate response links to the canonical
  `/{citySlug}/{listingSlug}`, not `/claim/{slug}` (a route that does not
  exist, and ambiguous because listing slugs are per city).
  `SubmitListingForm` renders both shapes.
- `SubmissionInput.ip` is now `string | null` so a request with no proxy
  header stores no IP rather than a placeholder.

### 6. New query modules

- `lib/db/queries/badges.ts` — `badgeListing(tx, viewer, id)`, published-only
  for non-admins, returns null for a malformed uuid. Used by
  `app/badge/[id]/route.ts` and `app/advertise/badge/page.tsx`, both of which
  had their own Drizzle selects (constraint 6).
- `lib/db/queries/enquiries.ts` — `createEnquiry(tx, viewer, input)` owns the
  published-only gate, the insert and the `enquiry_count` bump. The caller
  supplies the transaction, the same pattern `submit-listing` already used.

## Tests

51 new tests. TDD throughout: failing test first, then the code.

### RED → GREEN evidence

**Turnstile** — `corepack pnpm vitest run lib/spam/turnstile.test.ts`

RED (4 failures, e.g.):
```
FAIL lib/spam/turnstile.test.ts > fails closed when Cloudflare is unreachable
- Expected            + Received
-   "ok": false,      +   "ok": true,
-   "reason": "unreachable",  +   "reason": "verification unreachable: Error: ECONNREFUSED",
-   "skipped": false, +   "skipped": true,
Tests  4 failed | 8 passed (12)
```
GREEN: `Test Files 1 passed (1) / Tests 12 passed (12)`

**Rate limit + client IP** — `corepack pnpm vitest run lib/spam/rate-limit.test.ts lib/spam/client-ip.test.ts`

RED: `Test Files 2 failed (2) / Tests 3 failed | 4 passed (7)`
(`client-ip` module absent; fallback counter allowed past the limit;
`remembers the failure instead of reconnecting` — expected 4 to be 3.)
GREEN (whole directory): `Test Files 3 passed (3) / Tests 27 passed (27)`

**Action validation** — `corepack pnpm vitest run lib/actions/validation.test.ts`

RED: `Tests no tests` (module did not exist).
GREEN: `Test Files 1 passed (1) / Tests 17 passed (17)`

**badges** — `corepack pnpm vitest run lib/db/queries/badges.test.ts`
RED: `Tests no tests`. GREEN: `Tests 6 passed (6)`

**enquiries** — `corepack pnpm vitest run lib/db/queries/enquiries.test.ts`
RED: `Tests no tests`. GREEN: `Tests 7 passed (7)`

**Duplicate visibility** — `corepack pnpm vitest run lib/db/queries/submissions.test.ts`
RED:
```
× finds a published listing by name and postcode, with its canonical path
× finds a duplicate on a phone number punctuated differently
× returns null when nothing matches
× tells the public a match is pending without naming it
× says nothing about a removed listing either
× gives an admin the details of an unpublished match
Tests  6 failed | 14 passed (20)
```
GREEN: `Tests 20 passed (20)`

### Full suite

```
corepack pnpm typecheck   → clean
corepack pnpm test        → Test Files 41 passed (41) / Tests 514 passed (514)
bash scripts/check-niche-strings.sh → OK
NEXT_PUBLIC_SITE_URL=… DATABASE_URL=… REDIS_URL=… corepack pnpm build → succeeds
```

### Browser verification of the component work

Vitest is `environment: "node"` with `include: ["**/*.test.ts"]`, so this repo
has no React component tests and I did not invent a harness for one. The
widget was verified against a real production build instead
(`pnpm build && pnpm start -p 3201`, dev DB, Turnstile testing keys), driven
by throwaway Playwright specs in the scratchpad:

- enquiry submits end to end with Turnstile configured — widget renders,
  issues a token, the action verifies it against Cloudflare, the confirmation
  replaces the form: **passed**
- a short message is rejected before Turnstile is consulted: **passed**
- the widget is reset after the action returns an error (the hidden input's
  value changes to a fresh non-empty token): **passed**

## Deviations and concerns

1. **Requirement 7 could not be met as written, and I changed two files
   outside the brief's ownership list to satisfy its intent.**
   The brief says to keep `e2e/enquiry.spec.ts` passing "without a Turnstile
   key set (dev mode skips)". It does not run in dev mode: `playwright.config.ts`
   builds and runs `next start`, which sets `NODE_ENV=production` — the exact
   case requirement 1 makes fail closed. I confirmed this empirically: after
   the Turnstile commit, `playwright test e2e/enquiry.spec.ts` failed with
   "confirmation must replace the form" (1 failed, 1 passed).
   Resolution: `playwright.config.ts` now supplies Cloudflare's published
   testing keys (`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`,
   both overridable from the environment — I verified against the live
   siteverify endpoint that the testing secret accepts any token), and
   `e2e/enquiry.spec.ts` waits for the token before clicking submit.
   **Please confirm this is the resolution you want.** The alternative —
   weakening the production check so a keyless production build skips
   verification — reinstates the bug the task exists to fix.
   Side effect: the e2e enquiry test now makes a real request to
   `challenges.cloudflare.com`, so it fails offline. That is the honest
   consequence of failing closed.

2. **The real `pnpm test:e2e` could not be run to completion.** Another
   parallel worker holds port 3200 with its own `next-server`, and
   `reuseExistingServer` is true locally, so a run here would have tested
   their build. I verified on port 3201 with my own build instead. Someone
   should run the full e2e suite once the worktrees are merged.

3. **Shared ISR cache across workers.** `cache-handler.mjs` stores rendered
   pages in the shared Redis under `nextjs:`, keyed by path and not by build,
   so listing pages built by one worker are served by another. This cost me
   an hour of false negatives (a listing page served without the widget from
   a stale entry). It will make the e2e enquiry test flaky while several
   workers share Redis; it should be fine after merge.

4. **CR/LF is stripped from the enquiry message body too.** The brief says
   "every string field", so that is what I did, but a visitor's paragraph
   breaks are now collapsed to spaces. The injection risk the requirement
   guards against is real for `name`/`phone`/`email`; for `message` it costs
   formatting. Easy to narrow if you would rather keep newlines in the body.

5. **`rateLimitSubject(null)` means no effective limit for requests with no
   proxy header**, since every such request gets its own bucket. That is what
   the requirement asks for and it is strictly better than one shared bucket
   everyone can be locked out of, but behind a misconfigured proxy it means
   the cap is not enforced. Worth an alert on "no XFF in production" at some
   point.

6. **`createEnquiry` and `badgeListing` let an admin viewer through to
   unpublished rows**, matching `listings.ts` and the rest of the query layer.
   For `createEnquiry` that means an admin can file an enquiry against a
   pending listing. It is deliberate and tested; say so if you would rather
   enquiries were published-only regardless of viewer.

7. **Out of scope, spotted in passing:** `components/listing/ListingDetail.tsx:80`
   still links to `/claim/${listing.slug}` — the same non-existent, ambiguous
   route I removed from the submit flow. I left it alone because my brief
   restricts my `ListingDetail` change to the site-key prop.

8. **Out of scope, spotted in passing:** `cache-handler.mjs` does not fall back
   to the LRU handler when Redis is unreachable — it throws
   `Error: The client is closed` from line 28 on every request. Reproduced by
   starting the app with `REDIS_URL=redis://127.0.0.1:1`.

9. **Pre-existing flakiness:** `lib/routing/resolve.test.ts` and
   `lib/routing/slugs.test.ts` time out under parallel load against the shared
   `directory_test` database. Present before my first commit; unrelated to
   this work.
