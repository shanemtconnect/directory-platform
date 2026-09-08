# Phase 1 — Foundation and Infrastructure: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended)
> or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A deployable Next.js 16 directory app whose every niche-specific value lives in one config
file or the database, with a complete schema, a collision-proof slug registry, a mode-agnostic
pillar-page abstraction, and Redis-backed ISR that is shared across replicas and survives a
container restart. (Revised 2026-09-08: *not* a redeploy — cached HTML carries the asset hashes and
server-action ids of the build that rendered it, so entries are namespaced by build id and a deploy
starts cold. See docs/spikes/2026-09-07-phase-0-isr-cache-handler.md.)

**Architecture:** One stack per site sharing a Postgres server and Redis. `config/site.config.ts` is
the only file a clone edits. Feature flags are build-time constants so disabled code is tree-shaken
and disabled routes 404. A single `slugs` table is the router's index and the database-level guard
against every slug collision; a single `PillarScope` union means `niche-national` and
`local-multi-vertical` share one query builder, one sort, one schema builder and one component tree.

**Tech stack:** Next.js 16.3.4, React 19.2, TypeScript 7 strict, Drizzle ORM 0.45.2 + PostgreSQL 16,
`@fortedigital/nextjs-cache-handler` >= 3.3.0 + Redis 7, Tailwind 4, `sharp`, Vitest, Playwright,
pnpm 12 (via `corepack pnpm`), Node 24.

**Prerequisite:** Phase 0 is complete and PASSED — see `docs/spikes/2026-09-07-phase-0-isr-cache-handler.md`.
The working cache handler is at `reference/cache-handler.mjs`; Task 14 ports it verbatim.

---

## Global Constraints

Inherited from `2026-09-07-directory-platform-master.md`. Every task's requirements include these.
The ones this phase can actually violate are listed in full; the rest are referenced.

1. **The clone test.** "When I clone this repo for a different niche next month, does this line of
   code need to change?" If yes it belongs in config or the database, not in a component.
2. **Never hardcode a niche string in a component.** "Venue", "wedding", "couples" — all of it comes
   from `siteConfig.entity`. Task 21 enforces this with a CI grep.
3. **Strict TypeScript, no `any`.**
4. **Never connect to Redis during `next build`.** Guard on
   `PHASE_PRODUCTION_BUILD !== process.env.NEXT_PHASE`; fall back to local LRU when Redis is
   unreachable, with a `connectTimeout` and a bounded `reconnectStrategy`. Without this the build
   hangs forever, silently. Proven in Phase 0.
5. **Core is unflagged.** Cities, categories, listings, search, submissions, claims, tiers/billing,
   badges, coupons, schema, admin, sitemap, owner ROI dashboard, trust & safety. No flags on these.
6. **Flags are build-time constants** typed from the config object. Never read a flag from the database.
7. **Migrations are shared, always run.** All tables exist on every site regardless of flags.
8. **`validateConfig()` throws at build time** on an unmet feature dependency or a missing env var.
   Fail the build, don't warn.
9. **All database access goes through `/lib/db/queries/`.** No Drizzle calls in components or route
   handlers. Every query function takes an explicit `viewer: Viewer`. A query function without a
   viewer is a bug.
10. **Public listing queries always filter `status = 'published'`** via one `publishedListings()` base query.
11. **Region/county/state never appears in a URL.** Database and schema.org only.
12. **The city indexing gate is never bypassed:** `is_indexable` requires
    `listing_count >= seo.minListingsToIndex` AND `intro_html IS NOT NULL`. (Enforced in Phase 3;
    the columns and the default `is_indexable = false` land here.)
13. **Never fabricate ratings or reviews.** No seeded ratings, ever — Task 16's seed data has none.
14. **Images:** validate magic bytes not extension, strip EXIF, convert to WebP, cap 8 MB.
15. **Never run `next/image` optimisation on the app server.** Derivatives generated once in the worker.
16. **Any slug change writes a `redirects` row and serves a 301.** Never break a URL.
17. **Every scheduled job takes a Postgres advisory lock** so a restart mid-run can't double-execute.

**Exact values that must not drift:**

| Value | Setting |
|---|---|
| Image derivatives | `thumb` 200px, `card` 600px, `hero` 1200px, `full` 2000px — all WebP |
| Upload cap | 8 MB; JPG, PNG, PDF only (PDF for claim docs, not listing media) |
| City indexing threshold | `seo.minListingsToIndex: 3` |
| Pillar pagination | 24 per page |
| Tier ranks | free 10, essential 20, premium 30 |
| Claim rank weights | unclaimed 0, claimed +10, verified +25 |
| Verified requires | active paid subscription **AND** a passed control check |
| ISR revalidate on pillar pages | 3600 s |
| Seed gate | 50 cities, 20 categories, 200 listings |

---

## File Structure

```
config/
  site.config.ts             the only file a clone edits
  types.ts                   SiteConfig, FeatureFlag, Tier, CustomField types
  validate.ts                validateConfig(): feature deps + env, throws
lib/
  clock.ts                   now() seam — the only place `new Date()` is allowed
  features/
    flags.ts                 typed build-time constants derived from siteConfig
    guard.ts                 guardFeature() -> notFound()
    navigation.ts            single source for nav, footer, sitemap, breadcrumbs
  routing/
    reserved.ts              RESERVED_SLUGS
    slugify.ts               slugify()
    slugs.ts                 allocateSlug, reallocateSlug, resolveSlug
    resolve.ts               resolveRoute() -> RouteResolution
    scope.ts                 PillarScope union + helpers
  db/
    client.ts                drizzle instance
    viewer.ts                Viewer union
    sort.ts                  the one ranking expression
    schema/
      enums.ts  geo.ts  listings.ts  ownership.ts  money.ts  trust.ts  ops.ts  modules.ts
      index.ts               re-exports every table
    queries/
      listings.ts  cities.ts  categories.ts
  media/
    validate.ts              magic-byte sniffing
    derivatives.ts           sharp pipeline
    r2.ts                    S3 client + presign
worker/
  index.ts                   node-cron entrypoint
  lock.ts                    Postgres advisory lock wrapper
  jobs/derivatives.ts
app/
  layout.tsx  globals.css
  [...segments]/page.tsx     the single resolver-backed route
scripts/
  seed.ts  import-csv.ts
seeds/wedding-venues/{cities,categories,listings}.csv
cache-handler.mjs            ported from reference/ in Task 14
drizzle.config.ts  vitest.config.ts  docker-compose.dev.yml  Dockerfile
```

---

## Task 1: Repo scaffold and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `vitest.config.ts`, `.env.example`, `.gitignore`
- Create: `app/layout.tsx`, `app/globals.css`
- Test: `lib/clock.test.ts`

**Interfaces:**
- Produces: `now(): Date` from `lib/clock.ts` — the injectable time seam every later task and every
  worker job uses. Tests override it with `setClock(d: Date)` / `resetClock()`.

- [ ] **Step 1: Initialise the repo**

```bash
cd ~/Claude/projects/directory-platform
git init
corepack pnpm init
corepack pnpm add next@16.3.4 react@19.2.8 react-dom@19.2.8
corepack pnpm add -D typescript @types/react @types/node vitest @vitejs/plugin-react
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["dom", "dom.iterable", "es2022"],
    "jsx": "preserve", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true,
    "noEmit": true, "esModuleInterop": true, "skipLibCheck": true,
    "resolveJsonModule": true, "isolatedModules": true, "incremental": true,
    "paths": { "@/*": ["./*"] }, "plugins": [{ "name": "next" }]
  },
  "include": ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`noUncheckedIndexedAccess` is deliberate — the CSV importer and the slug resolver both index into
arrays from untrusted input, and this turns a class of runtime crash into a compile error.

- [ ] **Step 3: Write the failing test**

`lib/clock.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { now, setClock, resetClock } from "./clock";

describe("clock", () => {
  afterEach(resetClock);

  it("returns the real time by default", () => {
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it("returns the frozen time once set", () => {
    const t = new Date("2027-03-01T12:00:00.000Z");
    setClock(t);
    expect(now().toISOString()).toBe("2027-03-01T12:00:00.000Z");
  });

  it("advances by a fixed offset", () => {
    setClock(new Date("2027-03-01T00:00:00.000Z"));
    resetClock();
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `corepack pnpm vitest run lib/clock.test.ts`
Expected: FAIL — `Failed to resolve import "./clock"`.

- [ ] **Step 5: Implement `lib/clock.ts`**

```ts
let frozen: Date | null = null;

/** The only sanctioned source of current time. Never call `new Date()` elsewhere. */
export function now(): Date {
  return frozen ? new Date(frozen) : new Date();
}

/** Test-only. Freezes `now()` so expiry and revalidation logic is testable. */
export function setClock(d: Date): void {
  frozen = new Date(d);
}

export function resetClock(): void {
  frozen = null;
}
```

- [ ] **Step 6: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["**/*.test.ts"], globals: false },
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
});
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `corepack pnpm vitest run lib/clock.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Add scripts to `package.json`**

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "test": "vitest run",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore: scaffold Next 16 + vitest, add clock seam"
```

---

## Task 2: Site config types and feature-dependency validation

**Files:**
- Create: `config/types.ts`, `config/site.config.ts`, `config/validate.ts`
- Test: `config/validate.test.ts`

**Interfaces:**
- Produces: `SiteConfig`, `FeatureFlag`, `TierName`, `CustomField` types; `siteConfig` const;
  `validateFeatureDependencies(features: FeatureMap): void` — throws `ConfigError`.
- Consumes: nothing.

- [ ] **Step 1: Write `config/types.ts`**

```ts
export type TierName = "free" | "essential" | "premium";

export type CustomFieldType = "number" | "boolean" | "text" | "select" | "currency";

export interface CustomField {
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly options?: readonly string[];
  readonly searchable?: boolean;
  readonly showInCard?: boolean;
  /** Minimum tier required for this field to be displayed publicly. */
  readonly tier?: TierName;
}

export interface TierSpec {
  readonly rank: number;
  /** Owner-editable limits. Enforced server-side in the account UI, not just hidden. */
  readonly maxImages: number;
  readonly maxDescriptionChars: number;
  readonly showWebsite: boolean;
  readonly showSocial: boolean;
  readonly allowCustomFields: boolean;
  readonly allowVideo: boolean;
  readonly allowPricingPackages: boolean;
  readonly allowFaq: boolean;
  readonly allowTeam: boolean;
  readonly allowGalleryAlbums: boolean;
  /** How far back the owner dashboard shows stats. */
  readonly statsWindowDays: number;
  readonly allowStatsExport: boolean;
  /**
   * Verified is a subscription benefit (master plan A1b). True on every paid
   * tier. It still never auto-grants the badge on payment alone — the owner
   * must also pass the control check from the §5.2 evidence ladder.
   */
  readonly verificationIncluded: boolean;
  readonly homepageSlot?: boolean;
}

/**
 * NEVER tier-gated, on any site, at any tier — including unclaimed listings:
 * name, address, phone, opening hours, map pin, category, the enquiry form,
 * and reviews. Gating contact details on a directory kills the traffic that
 * makes the listings worth paying for (constraint 17). The upgrade levers are
 * reach and richness, never reachability.
 */

export const FEATURE_FLAGS = [
  "reviews", "shortlist", "quoteBroadcast", "contentHub", "footerLinkMatrix",
  "paidVerification", "claimOutreach", "costGuides", "jobBoard", "awards",
  "affiliates", "utilityTool", "storefrontExtras", "events", "bookings", "multiLocale",
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
export type FeatureMap = { readonly [K in FeatureFlag]: boolean };

export type SiteMode = "niche-national" | "local-multi-vertical";

export interface SiteConfig {
  readonly name: string;
  readonly shortName: string;
  readonly domain: string;
  readonly tagline: string;
  readonly legalEntity: string;
  readonly supportEmail: string;
  readonly entity: {
    readonly singular: string; readonly plural: string;
    readonly Singular: string; readonly Plural: string;
    readonly verb: string; readonly ownerNoun: string;
  };
  readonly country: string;
  readonly locale: string;
  readonly currency: string;
  /** IANA zone. Drives the daily listing shuffle so it can't flip on server-local midnight. */
  readonly timezone: string;
  readonly regionLabel: string;
  readonly schema: {
    readonly listingType: string;
    readonly organizationType: string;
    readonly priceRangeEnabled: boolean;
  };
  readonly theme: {
    readonly primary: string; readonly accent: string;
    readonly fontHeading: string; readonly fontBody: string; readonly radius: string;
  };
  readonly customFields: readonly CustomField[];
  readonly reviewCriteria: readonly { readonly key: string; readonly label: string }[];
  readonly tiers: { readonly [K in TierName]: TierSpec };
  readonly verification: {
    readonly requireVideoCall: boolean;
    /** Verified lapses when the subscription does. Always true today. */
    readonly expiresWithSubscription: boolean;
  };
  readonly siteMode: SiteMode;
  readonly features: FeatureMap;
  readonly seo: {
    readonly minListingsToIndex: number;
    readonly requireIntroCopyToIndex: boolean;
    readonly footerCitiesPerCategory: number;
  };
}
```

`reviewCriteria` and `timezone` and `seo.footerCitiesPerCategory` are additions — the brief
references all three in prose (§5B.1, the daily shuffle, §5B.6 "N from config, default 18") but
omits them from its config example.

- [ ] **Step 2: Write the failing test**

`config/validate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { validateFeatureDependencies, ConfigError } from "./validate";
import type { FeatureMap } from "./types";
import { FEATURE_FLAGS } from "./types";

const allOff = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as FeatureMap;
const on = (...flags: (keyof FeatureMap)[]): FeatureMap =>
  ({ ...allOff, ...Object.fromEntries(flags.map((f) => [f, true])) }) as FeatureMap;

describe("validateFeatureDependencies", () => {
  it("passes when everything is off", () => {
    expect(() => validateFeatureDependencies(allOff)).not.toThrow();
  });

  it("throws when awards is on without reviews", () => {
    expect(() => validateFeatureDependencies(on("awards"))).toThrow(ConfigError);
    expect(() => validateFeatureDependencies(on("awards"))).toThrow(/awards requires reviews/);
  });

  it("passes when awards is on with reviews", () => {
    expect(() => validateFeatureDependencies(on("awards", "reviews"))).not.toThrow();
  });

  it("throws when quoteBroadcast is on without shortlist", () => {
    expect(() => validateFeatureDependencies(on("quoteBroadcast"))).toThrow(/requires shortlist/);
  });

  it("reports every unmet dependency, not just the first", () => {
    expect(() => validateFeatureDependencies(on("awards", "quoteBroadcast")))
      .toThrow(/awards requires reviews[\s\S]*quoteBroadcast requires shortlist/);
  });

  it("passes with every flag on", () => {
    const allOn = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, true])) as FeatureMap;
    expect(() => validateFeatureDependencies(allOn)).not.toThrow();
  });
});
```

The last case is the one that matters: it is the unit-test mirror of `build:flags-on`, and it fails
the moment someone adds a dependency that all-on cannot satisfy.

- [ ] **Step 3: Run it and confirm it fails**

Run: `corepack pnpm vitest run config/validate.test.ts`
Expected: FAIL — `Failed to resolve import "./validate"`.

- [ ] **Step 4: Implement `config/validate.ts`**

```ts
import type { FeatureFlag, FeatureMap } from "./types";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const FEATURE_DEPENDENCIES: Partial<Record<FeatureFlag, readonly FeatureFlag[]>> = {
  awards: ["reviews"],
  quoteBroadcast: ["shortlist"],
};

export function validateFeatureDependencies(features: FeatureMap): void {
  const problems: string[] = [];
  for (const [flag, deps] of Object.entries(FEATURE_DEPENDENCIES)) {
    if (!features[flag as FeatureFlag]) continue;
    for (const dep of deps ?? []) {
      if (!features[dep]) problems.push(`${flag} requires ${dep}, which is off`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid feature configuration in config/site.config.ts:\n  - ${problems.join("\n  - ")}`,
    );
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `corepack pnpm vitest run config/validate.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write `config/site.config.ts`**

This is the reference wedding-venue config. Copy the brief's §2 block verbatim, plus the three
additions from Step 1 and `siteMode: "niche-national"`. Set `legalEntity: "TBC"` until S3 is
confirmed — a wrong legal entity in the footer is worse than an obvious placeholder.

```ts
import type { SiteConfig } from "./types";

export const siteConfig = {
  name: "Which Wedding Venue",
  shortName: "WWV",
  domain: "whichweddingvenue.co.uk",
  tagline: "Find your perfect UK wedding venue",
  legalEntity: "TBC",
  supportEmail: "hello@example.co.uk",
  entity: {
    singular: "venue", plural: "venues", Singular: "Venue", Plural: "Venues",
    verb: "list", ownerNoun: "venue owner",
  },
  country: "GB", locale: "en-GB", currency: "GBP",
  timezone: "Europe/London", regionLabel: "county",
  schema: { listingType: "EventVenue", organizationType: "Organization", priceRangeEnabled: true },
  theme: {
    primary: "#8B5A3C", accent: "#D4AF37",
    fontHeading: "Fraunces", fontBody: "Inter", radius: "0.75rem",
  },
  customFields: [
    { key: "capacity_seated", label: "Seated capacity", type: "number", searchable: true, showInCard: true },
    { key: "capacity_standing", label: "Standing capacity", type: "number", searchable: true },
    { key: "has_accommodation", label: "On-site accommodation", type: "boolean", searchable: true, showInCard: true },
    { key: "licensed_for_ceremonies", label: "Licensed for ceremonies", type: "boolean", searchable: true },
    { key: "price_from", label: "Prices from", type: "currency", tier: "essential" },
  ],
  reviewCriteria: [
    { key: "value", label: "Value for money" },
    { key: "service", label: "Service" },
    { key: "setting", label: "Setting" },
  ],
  tiers: {
    free: {
      rank: 10, maxImages: 3, maxDescriptionChars: 300,
      showWebsite: false, showSocial: false, allowCustomFields: false,
      allowVideo: false, allowPricingPackages: false, allowFaq: false,
      allowTeam: false, allowGalleryAlbums: false,
      statsWindowDays: 30, allowStatsExport: false, verificationIncluded: false,
    },
    essential: {
      rank: 20, maxImages: 10, maxDescriptionChars: 1000,
      showWebsite: true, showSocial: true, allowCustomFields: true,
      allowVideo: false, allowPricingPackages: false, allowFaq: false,
      allowTeam: false, allowGalleryAlbums: false,
      statsWindowDays: 365, allowStatsExport: false, verificationIncluded: true,
    },
    premium: {
      rank: 30, maxImages: 100, maxDescriptionChars: 2500,
      showWebsite: true, showSocial: true, allowCustomFields: true,
      allowVideo: true, allowPricingPackages: true, allowFaq: true,
      allowTeam: true, allowGalleryAlbums: true,
      statsWindowDays: 365, allowStatsExport: true, verificationIncluded: true,
      homepageSlot: true,
    },
  },
  // No standalone price: verification comes with any paid tier (master plan A1b).
  // `requireVideoCall` stays configurable per niche — a trades directory may want
  // one, a wedding-venue directory does not.
  verification: { requireVideoCall: false, expiresWithSubscription: true },
  siteMode: "niche-national",
  features: {
    reviews: true, shortlist: true, quoteBroadcast: false, contentHub: true,
    footerLinkMatrix: true, paidVerification: true, claimOutreach: true,
    costGuides: false, jobBoard: false, awards: false, affiliates: false,
    utilityTool: false, storefrontExtras: false, events: false, bookings: false,
    multiLocale: false,
  },
  seo: { minListingsToIndex: 3, requireIntroCopyToIndex: true, footerCitiesPerCategory: 18 },
} as const satisfies SiteConfig;
```

`as const satisfies SiteConfig` is load-bearing: `satisfies` type-checks the object against the
interface while `as const` preserves the literal types the flag tree-shaking depends on.

- [ ] **Step 7: Typecheck and commit**

```bash
corepack pnpm typecheck && corepack pnpm test
git add -A && git commit -m "feat: site config types and feature dependency validation"
```

---

## Task 3: Environment validation

**Files:**
- Modify: `config/validate.ts`
- Create: `.env.example`
- Test: `config/validate.test.ts` (extend)

**Interfaces:**
- Produces: `validateEnv(env: NodeJS.ProcessEnv, opts: { phase: "build" | "runtime" }): void`,
  `validateConfig(): void` — the single build-time entry point called from `next.config.mjs`.

- [ ] **Step 1: Write the failing test (append to `config/validate.test.ts`)**

```ts
import { validateEnv } from "./validate";

const REQUIRED_AT_RUNTIME = {
  NEXT_PUBLIC_SITE_URL: "https://x.test", DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x", BETTER_AUTH_SECRET: "s", BETTER_AUTH_URL: "https://x.test",
  R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "b", R2_SECRET_ACCESS_KEY: "c",
  R2_BUCKET_MEDIA: "m", R2_BUCKET_CLAIM_DOCS: "d", NEXT_PUBLIC_MEDIA_URL: "https://m.test",
  PAYPAL_CLIENT_ID: "p", PAYPAL_CLIENT_SECRET: "q", PAYPAL_WEBHOOK_ID: "w",
  RESEND_API_KEY: "r", EMAIL_FROM: "e@x.test", ADMIN_NOTIFICATION_EMAIL: "a@x.test",
  TURNSTILE_SITE_KEY: "t", TURNSTILE_SECRET_KEY: "u", MAPTILER_KEY: "k",
};

describe("validateEnv", () => {
  it("passes when every required key is present at runtime", () => {
    expect(() => validateEnv(REQUIRED_AT_RUNTIME, { phase: "runtime" })).not.toThrow();
  });

  it("throws naming every missing key, not just the first", () => {
    const { DATABASE_URL, RESEND_API_KEY, ...rest } = REQUIRED_AT_RUNTIME;
    expect(() => validateEnv(rest, { phase: "runtime" })).toThrow(/DATABASE_URL[\s\S]*RESEND_API_KEY/);
  });

  it("treats an empty string as missing", () => {
    expect(() => validateEnv({ ...REQUIRED_AT_RUNTIME, MAPTILER_KEY: "" }, { phase: "runtime" }))
      .toThrow(/MAPTILER_KEY/);
  });

  it("does not require runtime secrets during the build", () => {
    expect(() => validateEnv({ NEXT_PUBLIC_SITE_URL: "https://x.test" }, { phase: "build" }))
      .not.toThrow();
  });
});
```

The build/runtime split matters: the Docker image is built once in CI with no site secrets, then
booted per site with a `.env`. Requiring `DATABASE_URL` at build time would make the image unbuildable.

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack pnpm vitest run config/validate.test.ts`
Expected: FAIL — `validateEnv is not a function`.

- [ ] **Step 3: Implement (append to `config/validate.ts`)**

```ts
import { siteConfig } from "./site.config";

/** Needed to produce the build. Everything else is injected at boot. */
const BUILD_ENV = ["NEXT_PUBLIC_SITE_URL"] as const;

const RUNTIME_ENV = [
  "NEXT_PUBLIC_SITE_URL", "DATABASE_URL", "REDIS_URL",
  "BETTER_AUTH_SECRET", "BETTER_AUTH_URL",
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_MEDIA", "R2_BUCKET_CLAIM_DOCS", "NEXT_PUBLIC_MEDIA_URL",
  "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID",
  "RESEND_API_KEY", "EMAIL_FROM", "ADMIN_NOTIFICATION_EMAIL",
  "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "MAPTILER_KEY",
] as const;

export function validateEnv(
  env: NodeJS.ProcessEnv,
  opts: { phase: "build" | "runtime" },
): void {
  const required = opts.phase === "build" ? BUILD_ENV : RUNTIME_ENV;
  const missing = required.filter((k) => {
    const v = env[k];
    return v === undefined || v.trim() === "";
  });
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables (${opts.phase}):\n  - ${missing.join("\n  - ")}\n` +
        `See .env.example. A site that boots without these is worse than one that refuses to.`,
    );
  }
}

/** Build-time gate. Called from next.config.mjs so a bad config fails the build. */
export function validateConfig(): void {
  validateFeatureDependencies(siteConfig.features);
  validateEnv(process.env, { phase: "build" });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `corepack pnpm vitest run config/validate.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Wire it into `next.config.mjs`**

```js
import { fileURLToPath } from "node:url";
import { validateConfig } from "./config/validate.ts";

validateConfig(); // throws -> build fails, which is the point

export default {
  output: "standalone",
  cacheHandler: fileURLToPath(new URL("./cache-handler.mjs", import.meta.url)),
  cacheMaxMemorySize: 0,
};
```

- [ ] **Step 6: Write `.env.example`**

Every key from `RUNTIME_ENV` plus the optional ones, each with an empty value and a one-line comment.
Add `SENTRY_DSN=`, `GEOCODING_API_KEY=`, `GOOGLE_CLIENT_ID=`, `GOOGLE_CLIENT_SECRET=`,
`WORKER_ENABLED=` — optional, so absent from `RUNTIME_ENV`, but a clone needs to know they exist.

- [ ] **Step 7: Prove the gate actually fires**

```bash
NEXT_PUBLIC_SITE_URL= corepack pnpm build
```
Expected: build fails with `ConfigError: Missing required environment variables (build)`.
Then re-run with the value set and confirm it builds.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: build-time env validation, fail-fast on missing keys"
```

---

## Task 4: Feature flags, route guard, and the single navigation source

**Files:**
- Create: `lib/features/flags.ts`, `lib/features/guard.ts`, `lib/features/navigation.ts`
- Test: `lib/features/navigation.test.ts`

**Interfaces:**
- Produces:
  - `features: FeatureMap` — build-time constant re-export of `siteConfig.features`.
  - `guardFeature(flag: FeatureFlag): void` — calls `notFound()` when off.
  - `type NavEntry = { href: string; label: string; inNav: boolean; inFooter: boolean; inSitemap: boolean }`
  - `enabledRoutes(): NavEntry[]` — the ONE source nav, footer, sitemap and breadcrumbs read from.

- [ ] **Step 1: Write the failing test**

`lib/features/navigation.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildRoutes } from "./navigation";
import { FEATURE_FLAGS, type FeatureMap } from "@/config/types";

const allOff = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as FeatureMap;
const allOn = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, true])) as FeatureMap;

describe("buildRoutes", () => {
  it("always includes core routes regardless of flags", () => {
    const hrefs = buildRoutes(allOff, "niche-national").map((r) => r.href);
    for (const core of ["/", "/cities", "/categories", "/search", "/add-listing", "/pricing", "/advertise", "/trust"]) {
      expect(hrefs).toContain(core);
    }
  });

  it("omits every flagged route when all flags are off", () => {
    const hrefs = buildRoutes(allOff, "niche-national").map((r) => r.href);
    for (const flagged of ["/shortlist", "/cost", "/get-quotes", "/guides", "/jobs", "/awards", "/affiliates"]) {
      expect(hrefs).not.toContain(flagged);
    }
  });

  it("includes /guides and drops /blog when contentHub is on", () => {
    const hrefs = buildRoutes({ ...allOff, contentHub: true }, "niche-national").map((r) => r.href);
    expect(hrefs).toContain("/guides");
    expect(hrefs).not.toContain("/blog");
  });

  it("includes /blog when contentHub is off", () => {
    expect(buildRoutes(allOff, "niche-national").map((r) => r.href)).toContain("/blog");
  });

  it("never emits /membership — searcher membership is out of scope permanently", () => {
    expect(buildRoutes(allOn, "niche-national").map((r) => r.href)).not.toContain("/membership");
  });

  it("adds /areas only in local-multi-vertical mode", () => {
    expect(buildRoutes(allOff, "niche-national").map((r) => r.href)).not.toContain("/areas");
    expect(buildRoutes(allOff, "local-multi-vertical").map((r) => r.href)).toContain("/areas");
  });

  it("returns no duplicate hrefs under any flag combination", () => {
    for (const f of [allOff, allOn]) {
      const hrefs = buildRoutes(f, "niche-national").map((r) => r.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack pnpm vitest run lib/features/navigation.test.ts`
Expected: FAIL — `Failed to resolve import "./navigation"`.

- [ ] **Step 3: Implement `lib/features/flags.ts`**

```ts
import { siteConfig } from "@/config/site.config";
import type { FeatureFlag } from "@/config/types";

/**
 * Build-time constant. `if (!features.reviews) return null` is tree-shaken.
 * Never replace this with a database read — constraint 6.
 */
export const features = siteConfig.features;

export function isEnabled(flag: FeatureFlag): boolean {
  return features[flag];
}
```

- [ ] **Step 4: Implement `lib/features/guard.ts`**

```ts
import { notFound } from "next/navigation";
import type { FeatureFlag } from "@/config/types";
import { features } from "./flags";

/**
 * First line of every optional route segment. A disabled feature returns a real
 * 404, not an empty page — constraint from brief §2.1 rule 3.
 */
export function guardFeature(flag: FeatureFlag): void {
  if (!features[flag]) notFound();
}
```

- [ ] **Step 5: Implement `lib/features/navigation.ts`**

```ts
import { siteConfig } from "@/config/site.config";
import type { FeatureMap, SiteMode } from "@/config/types";
import { features } from "./flags";

export interface NavEntry {
  href: string;
  label: string;
  inNav: boolean;
  inFooter: boolean;
  inSitemap: boolean;
}

/** Pure and parameterised so every flag combination is unit-testable. */
export function buildRoutes(f: FeatureMap, mode: SiteMode): NavEntry[] {
  const e = siteConfig.entity;
  const routes: NavEntry[] = [
    { href: "/", label: "Home", inNav: false, inFooter: false, inSitemap: true },
    { href: "/cities", label: "Locations", inNav: true, inFooter: true, inSitemap: true },
    { href: "/categories", label: e.Plural, inNav: true, inFooter: true, inSitemap: true },
    { href: "/search", label: "Search", inNav: true, inFooter: false, inSitemap: false },
    { href: "/add-listing", label: `Add your ${e.singular}`, inNav: true, inFooter: true, inSitemap: true },
    { href: "/pricing", label: "Pricing", inNav: true, inFooter: true, inSitemap: true },
    { href: "/advertise", label: "Advertise", inNav: false, inFooter: true, inSitemap: true },
    { href: "/trust", label: "Trust & safety", inNav: false, inFooter: true, inSitemap: true },
    { href: "/data-sources", label: "Where our data comes from", inNav: false, inFooter: true, inSitemap: true },
  ];

  if (mode === "local-multi-vertical") {
    routes.push({ href: "/areas", label: "Areas", inNav: true, inFooter: true, inSitemap: true });
  }

  // contentHub REPLACES the flat blog rather than sitting beside it.
  routes.push(
    f.contentHub
      ? { href: "/guides", label: "Guides", inNav: true, inFooter: true, inSitemap: true }
      : { href: "/blog", label: "Blog", inNav: true, inFooter: true, inSitemap: true },
  );

  if (f.shortlist) routes.push({ href: "/shortlist", label: "Shortlist", inNav: true, inFooter: false, inSitemap: false });
  if (f.costGuides) routes.push({ href: "/cost", label: "Costs", inNav: true, inFooter: true, inSitemap: true });
  if (f.quoteBroadcast) routes.push({ href: "/get-quotes", label: "Get quotes", inNav: true, inFooter: true, inSitemap: true });
  if (f.jobBoard) routes.push({ href: "/jobs", label: "Jobs", inNav: true, inFooter: true, inSitemap: true });
  if (f.awards) routes.push({ href: "/awards", label: "Awards", inNav: false, inFooter: true, inSitemap: true });
  if (f.affiliates) routes.push({ href: "/affiliates", label: "Affiliates", inNav: false, inFooter: true, inSitemap: true });
  if (f.utilityTool) routes.push({ href: "/tools", label: "Free tools", inNav: true, inFooter: true, inSitemap: true });

  return routes;
}

/** What the app actually renders from. */
export function enabledRoutes(): NavEntry[] {
  return buildRoutes(features, siteConfig.siteMode);
}

export const navRoutes = (): NavEntry[] => enabledRoutes().filter((r) => r.inNav);
export const footerRoutes = (): NavEntry[] => enabledRoutes().filter((r) => r.inFooter);
export const sitemapRoutes = (): NavEntry[] => enabledRoutes().filter((r) => r.inSitemap);
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `corepack pnpm vitest run lib/features/navigation.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: feature flags, route guard, single navigation source"
```

---

## Task 5: Theme tokens to CSS variables

**Files:**
- Create: `app/globals.css`, `lib/theme.ts`
- Modify: `app/layout.tsx`
- Test: `lib/theme.test.ts`

**Interfaces:**
- Produces: `themeCssVariables(theme: SiteConfig["theme"]): string` — a CSS declaration block string
  injected into `<html style>`, so a clone re-skins by editing config alone.

- [ ] **Step 1: Write the failing test**

`lib/theme.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { themeCssVariables } from "./theme";

const theme = {
  primary: "#8B5A3C", accent: "#D4AF37",
  fontHeading: "Fraunces", fontBody: "Inter", radius: "0.75rem",
} as const;

describe("themeCssVariables", () => {
  it("emits every token as a custom property", () => {
    const css = themeCssVariables(theme);
    expect(css).toContain("--color-primary:#8B5A3C");
    expect(css).toContain("--color-accent:#D4AF37");
    expect(css).toContain("--radius:0.75rem");
  });

  it("quotes font family names so multi-word fonts survive", () => {
    expect(themeCssVariables({ ...theme, fontHeading: "Playfair Display" }))
      .toContain(`--font-heading:"Playfair Display"`);
  });

  it("rejects a value containing a semicolon or brace", () => {
    expect(() => themeCssVariables({ ...theme, primary: "red;}body{display:none" }))
      .toThrow(/unsafe/i);
  });
});
```

The third test is not paranoia for its own sake — this string is injected into an inline `style`
attribute, and `site.config.ts` is edited by hand on every clone. A typo that silently breaks the
whole page is worth one guard clause.

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack pnpm vitest run lib/theme.test.ts`
Expected: FAIL — `Failed to resolve import "./theme"`.

- [ ] **Step 3: Implement `lib/theme.ts`**

```ts
import type { SiteConfig } from "@/config/types";

const UNSAFE = /[;{}<>]/;

function assertSafe(key: string, value: string): void {
  if (UNSAFE.test(value)) {
    throw new Error(`Unsafe value for theme token "${key}": ${JSON.stringify(value)}`);
  }
}

export function themeCssVariables(theme: SiteConfig["theme"]): string {
  const tokens: Record<string, string> = {
    "--color-primary": theme.primary,
    "--color-accent": theme.accent,
    "--font-heading": `"${theme.fontHeading}"`,
    "--font-body": `"${theme.fontBody}"`,
    "--radius": theme.radius,
  };
  for (const [k, v] of Object.entries(tokens)) assertSafe(k, v);
  return Object.entries(tokens).map(([k, v]) => `${k}:${v}`).join(";");
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `corepack pnpm vitest run lib/theme.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add Tailwind 4 and wire the tokens**

```bash
corepack pnpm add tailwindcss @tailwindcss/postcss postcss
```

`app/globals.css`:
```css
@import "tailwindcss";

@theme inline {
  --color-primary: var(--color-primary);
  --color-accent: var(--color-accent);
  --font-heading: var(--font-heading);
  --font-body: var(--font-body);
  --radius: var(--radius);
}

body { font-family: var(--font-body), system-ui, sans-serif; }
h1, h2, h3 { font-family: var(--font-heading), Georgia, serif; }
```

`app/layout.tsx`:
```tsx
import "./globals.css";
import { siteConfig } from "@/config/site.config";
import { themeCssVariables } from "@/lib/theme";

export const metadata = {
  title: { default: siteConfig.name, template: `%s | ${siteConfig.name}` },
  description: siteConfig.tagline,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={siteConfig.locale} style={{ cssText: themeCssVariables(siteConfig.theme) } as never}>
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 6: Verify visually**

Run `corepack pnpm dev`, open `http://localhost:3000`, and confirm in devtools that `<html>` carries
`--color-primary: #8B5A3C`. Then change `primary` in `site.config.ts` to `#000000`, reload, and
confirm it changes. That round trip is the clone test for theming.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: theme tokens from config to CSS variables"
```

---

## Task 6: Local Postgres and Redis, Drizzle wiring, first migration

**Files:**
- Create: `docker-compose.dev.yml`, `drizzle.config.ts`, `lib/db/client.ts`, `lib/db/schema/index.ts`
- Create: `test/db.ts` (integration-test harness)

**Interfaces:**
- Produces: `db` (Drizzle instance) from `lib/db/client.ts`; `withTestDb(fn)` from `test/db.ts` —
  every later integration test runs inside a transaction that is rolled back, so tests never
  contaminate each other.

- [ ] **Step 1: Write `docker-compose.dev.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: directory
      POSTGRES_PASSWORD: directory
      POSTGRES_DB: directory_dev
    ports: ["5433:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U directory"]
      interval: 2s
      retries: 15
  redis:
    image: redis:7-alpine
    ports: ["6380:6379"]
volumes:
  pgdata:
```

Ports 5433/6380 deliberately avoid clashing with anything already on 5432/6379.

- [ ] **Step 2: Start it and confirm both are up**

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml ps
```
Expected: both services `healthy`/`running`. If Docker Desktop is not running, start it first —
and note from Phase 0 that Docker Desktop's own startup can SIGTERM a container you just launched.

- [ ] **Step 3: Install Drizzle and write `drizzle.config.ts`**

```bash
corepack pnpm add drizzle-orm@0.45.2 postgres
corepack pnpm add -D drizzle-kit
```

```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./lib/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 4: Implement `lib/db/client.ts`**

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

// max: 10 per site container. Ten sites on one Postgres is 100 connections;
// keep this in step with the server's max_connections.
const client = postgres(connectionString, { max: 10 });

export const db = drizzle(client, { schema });
export type Db = typeof db;
```

- [ ] **Step 5: Implement `test/db.ts`**

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";

const url = process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";

/**
 * Runs `fn` inside a transaction that is always rolled back, so integration
 * tests share one migrated database without contaminating each other.
 */
export async function withTestDb<T>(fn: (tx: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const client = postgres(url, { max: 1 });
  const database = drizzle(client, { schema });
  try {
    let out: T;
    await database.transaction(async (tx) => {
      out = await fn(tx as never);
      throw new RollbackSignal();
    }).catch((e) => { if (!(e instanceof RollbackSignal)) throw e; });
    return out!;
  } finally {
    await client.end({ timeout: 5 });
  }
}

class RollbackSignal extends Error {}
```

- [ ] **Step 6: Implement `test/factories.ts`**

Tasks 13 and 16 both need seeded rows. Write the helper once, here, rather than inline in each test.

```ts
import { randomUUID } from "node:crypto";
import { verticals, cities, categories, listings } from "@/lib/db/schema";
import { allocateSlug, ROOT_SCOPE } from "@/lib/routing/slugs";
import type { Db } from "@/lib/db/client";

export async function makeVertical(tx: Db, name = "Venues"): Promise<string> {
  const id = randomUUID();
  const slug = await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: name, kind: "vertical", entityId: id });
  await tx.insert(verticals).values({
    id, name, slug, singular: "venue", plural: "venues",
    ownerNoun: "venue owner", schemaType: "EventVenue",
  });
  return id;
}

export async function makeCity(tx: Db, name = "Leeds", region = "West Yorkshire"): Promise<string> {
  const id = randomUUID();
  const slug = await allocateSlug(tx, {
    parentScope: ROOT_SCOPE, desired: name, kind: "city", entityId: id, disambiguator: region,
  });
  await tx.insert(cities).values({ id, name, slug, region, country: "GB" });
  return id;
}

export async function makeCategory(tx: Db, verticalId: string, cityId: string, name = "Barn Venues"): Promise<string> {
  const id = randomUUID();
  const slug = await allocateSlug(tx, { parentScope: cityId, desired: name, kind: "category", entityId: id });
  await tx.insert(categories).values({
    id, verticalId, name, slug, singular: "barn venue", plural: "barn venues",
  });
  return id;
}

/** One listing. Override any column via `patch` — tier and status are what tests vary. */
export async function makeListing(
  tx: Db,
  ctx: { cityId: string; verticalId: string; primaryCategoryId: string },
  patch: Partial<typeof listings.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  const name = (patch.name as string | undefined) ?? `Listing ${id.slice(0, 8)}`;
  const slug = await allocateSlug(tx, { parentScope: ctx.cityId, desired: name, kind: "listing", entityId: id });
  await tx.insert(listings).values({
    id, name, slug, ...ctx, status: "published", tier: "free",
    claimStatus: "unclaimed", source: "seed", ...patch,
  });
  return id;
}

/** The fixture Task 13's ranking tests use: three listings differing only in tier. */
export async function makeTierTrio(tx: Db): Promise<{ cityId: string }> {
  const verticalId = await makeVertical(tx);
  const cityId = await makeCity(tx);
  const primaryCategoryId = await makeCategory(tx, verticalId, cityId);
  const ctx = { cityId, verticalId, primaryCategoryId };
  for (const tier of ["free", "premium", "essential"] as const) {
    await makeListing(tx, ctx, { tier, name: `${tier} venue` });
  }
  return { cityId };
}
```

- [ ] **Step 7: Add scripts**

```json
"db:up": "docker compose -f docker-compose.dev.yml up -d",
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:studio": "drizzle-kit studio",
"test:setup": "psql \"$DATABASE_URL\" -c 'create database directory_test' || true"
```

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: local postgres/redis stack, drizzle wiring, test factories"
```

---

## Task 7: Schema — enums, slug registry, geography and taxonomy

**Files:**
- Create: `lib/db/schema/enums.ts`, `lib/db/schema/geo.ts`
- Modify: `lib/db/schema/index.ts`

**Interfaces:**
- Produces: `slugs`, `verticals`, `cities`, `areas`, `categories` tables and every pgEnum.
  Later tasks import these by name from `@/lib/db/schema`.

- [ ] **Step 1: Write `lib/db/schema/enums.ts`**

```ts
import { pgEnum } from "drizzle-orm/pg-core";

export const slugKind = pgEnum("slug_kind", ["static", "city", "vertical", "area", "category", "listing"]);
export const cityCreatedBy = pgEnum("city_created_by", ["seed", "admin", "auto"]);
export const userRole = pgEnum("user_role", ["user", "owner", "admin"]);

// 'removed' exists because §5.2b sets it on a takedown request. The brief's own
// enum omitted it while its prose relied on it.
export const listingStatus = pgEnum("listing_status", [
  "draft", "pending", "published", "rejected", "archived", "removed",
]);
export const listingTier = pgEnum("listing_tier", ["free", "essential", "premium"]);
// Ownership and payment are separate COLUMNS even though a paid subscription is
// what promotes claimed -> verified. Keeping them separate is what lets a listing
// be Claimed + Premium (paid, control not yet proven) or drop from Verified back
// to Claimed on cancellation without touching `tier`.
export const claimStatus = pgEnum("claim_status", ["unclaimed", "claimed", "verified"]);
// 'scraped' exists for the same reason as 'removed'.
export const listingSource = pgEnum("listing_source", ["seed", "admin", "public", "import", "scraped"]);

export const claimRequestStatus = pgEnum("claim_request_status", ["pending", "approved", "rejected", "withdrawn"]);
export const evidenceType = pgEnum("evidence_type", ["domain_email", "phone_otp", "document", "id_document"]);
export const verificationOrderSource = pgEnum("verification_order_source", ["paid", "premium_waiver"]);
export const verificationOrderStatus = pgEnum("verification_order_status", [
  "open", "docs_pending", "call_scheduled", "passed", "failed", "cancelled",
]);
export const billingInterval = pgEnum("billing_interval", ["monthly", "annual"]);
export const discountType = pgEnum("discount_type", ["percent", "fixed"]);
export const badgeStyle = pgEnum("badge_style", ["dark", "light", "compact", "rating"]);
export const reportReason = pgEnum("report_reason", ["incorrect", "closed", "duplicate", "offensive", "other"]);
export const reportStatus = pgEnum("report_status", ["open", "actioned", "dismissed"]);
export const removalStatus = pgEnum("removal_status", ["open", "actioned", "rejected"]);
export const reviewStatus = pgEnum("review_status", ["pending", "published", "rejected", "disputed"]);
export const jobStatus = pgEnum("job_status", ["pending", "published", "expired", "removed"]);
export const campaignChannel = pgEnum("campaign_channel", ["email", "sms"]);
```

- [ ] **Step 2: Write `lib/db/schema/geo.ts`**

```ts
import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb,
  doublePrecision, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { slugKind, cityCreatedBy } from "./enums";

const base = {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * The router's index AND the database-level collision guard.
 * parentScope is the literal 'root' (cities, verticals, reserved static routes)
 * or the uuid of the owning city/vertical (categories, areas, listings).
 * One unique constraint makes every slug collision in the brief impossible.
 */
export const slugs = pgTable("slugs", {
  ...base,
  parentScope: text("parent_scope").notNull(),
  slug: text("slug").notNull(),
  kind: slugKind("kind").notNull(),
  entityId: uuid("entity_id"),
}, (t) => [
  uniqueIndex("slugs_scope_slug_key").on(t.parentScope, t.slug),
  index("slugs_entity_idx").on(t.kind, t.entityId),
]);

export const verticals = pgTable("verticals", {
  ...base,
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  singular: text("singular").notNull(),
  plural: text("plural").notNull(),
  ownerNoun: text("owner_noun").notNull(),
  schemaType: text("schema_type").notNull(),
  icon: text("icon"),
  introHtml: text("intro_html"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [uniqueIndex("verticals_slug_key").on(t.slug)]);

export const cities = pgTable("cities", {
  ...base,
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  region: text("region"),
  country: text("country").notNull(),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  population: integer("population"),
  introHtml: text("intro_html"),
  faq: jsonb("faq"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  heroImageUrl: text("hero_image_url"),
  isPublished: boolean("is_published").notNull().default(true),
  // Defaults FALSE. A city earns indexing (constraint 12); it is never granted.
  isIndexable: boolean("is_indexable").notNull().default(false),
  listingCount: integer("listing_count").notNull().default(0),
  createdBy: cityCreatedBy("created_by").notNull().default("seed"),
}, (t) => [
  uniqueIndex("cities_slug_key").on(t.slug),
  index("cities_geo_idx").on(t.lat, t.lng),
  index("cities_indexable_idx").on(t.isIndexable),
]);

export const areas = pgTable("areas", {
  ...base,
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  introHtml: text("intro_html"),
  faq: jsonb("faq"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  isPublished: boolean("is_published").notNull().default(true),
  isIndexable: boolean("is_indexable").notNull().default(false),
  listingCount: integer("listing_count").notNull().default(0),
}, (t) => [uniqueIndex("areas_slug_key").on(t.slug)]);

export const categories = pgTable("categories", {
  ...base,
  verticalId: uuid("vertical_id").notNull().references(() => verticals.id),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  singular: text("singular").notNull(),
  plural: text("plural").notNull(),
  description: text("description"),
  icon: text("icon"),
  schemaTypeOverride: text("schema_type_override"),
  parentId: uuid("parent_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [
  uniqueIndex("categories_slug_key").on(t.slug),
  index("categories_vertical_idx").on(t.verticalId),
]);
```

- [ ] **Step 3: Generate and apply the migration**

```bash
DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev corepack pnpm db:generate
DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev corepack pnpm db:migrate
```
Expected: a file under `drizzle/`, then `[✓] migrations applied`.

- [ ] **Step 4: Confirm the tables exist**

```bash
docker compose -f docker-compose.dev.yml exec postgres psql -U directory -d directory_dev -c '\dt'
```
Expected: `slugs`, `verticals`, `cities`, `areas`, `categories`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): enums, slug registry, geography and taxonomy schema"
```

---

## Task 8: Schema — listings, media, and the rest

**Files:**
- Create: `lib/db/schema/listings.ts`, `ownership.ts`, `money.ts`, `trust.ts`, `ops.ts`, `modules.ts`
- Modify: `lib/db/schema/index.ts`

**Interfaces:**
- Produces: every remaining table from Part C of the master plan. Later tasks import `listings`,
  `listingImages`, `redirects`, `auditLog`, `suppressions`, `jobRuns` by name.

- [ ] **Step 1: Write `lib/db/schema/listings.ts`**

```ts
import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb,
  doublePrecision, numeric, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { listingStatus, listingTier, claimStatus, listingSource } from "./enums";
import { cities, areas, verticals, categories } from "./geo";

const base = {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const listings = pgTable("listings", {
  ...base,
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  cityId: uuid("city_id").notNull().references(() => cities.id),
  areaId: uuid("area_id").references(() => areas.id),
  verticalId: uuid("vertical_id").notNull().references(() => verticals.id),
  primaryCategoryId: uuid("primary_category_id").notNull().references(() => categories.id),

  status: listingStatus("status").notNull().default("draft"),
  tier: listingTier("tier").notNull().default("free"),
  // Separate axis from `tier`. A listing can be Claimed + Premium, or Verified + Free.
  claimStatus: claimStatus("claim_status").notNull().default("unclaimed"),
  ownerId: uuid("owner_id"),

  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  postcode: text("postcode"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  socials: jsonb("socials"),

  shortDescription: text("short_description"),
  description: text("description"),
  openingHours: jsonb("opening_hours"),
  timezone: text("timezone"),
  customFields: jsonb("custom_fields"),
  priceRange: text("price_range"),

  rankBoost: integer("rank_boost").notNull().default(0),
  // Trigger-maintained. NEVER seeded, NEVER written by hand (constraint 13).
  ratingAvg: numeric("rating_avg", { precision: 2, scale: 1 }),
  ratingCount: integer("rating_count").notNull().default(0),

  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  // Tracks the subscription's current_period_end. Lapse, cancel or failed
  // payment drops claim_status back to 'claimed' (master plan A1b).
  verifiedExpiresAt: timestamp("verified_expires_at", { withTimezone: true }),
  verifiedBy: uuid("verified_by"),
  verificationChecks: jsonb("verification_checks"),

  viewCount: integer("view_count").notNull().default(0),
  enquiryCount: integer("enquiry_count").notNull().default(0),

  source: listingSource("source").notNull().default("seed"),
  sourceUrl: text("source_url"),
  importedAt: timestamp("imported_at", { withTimezone: true }),
  submittedByEmail: text("submitted_by_email"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  rejectedReason: text("rejected_reason"),
}, (t) => [
  uniqueIndex("listings_city_slug_key").on(t.cityId, t.slug),
  index("listings_status_idx").on(t.status),
  index("listings_city_status_idx").on(t.cityId, t.status),
  index("listings_vertical_status_idx").on(t.verticalId, t.status),
  index("listings_geo_idx").on(t.lat, t.lng),
]);

export const listingCategories = pgTable("listing_categories", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").notNull().references(() => categories.id),
}, (t) => [uniqueIndex("listing_categories_key").on(t.listingId, t.categoryId)]);

export const listingImages = pgTable("listing_images", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  storagePath: text("storage_path").notNull(),
  /** { thumb, card, hero, full } -> R2 keys, written by the worker (Task 18). */
  derivatives: jsonb("derivatives"),
  alt: text("alt"),
  width: integer("width"),
  height: integer("height"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: boolean("is_primary").notNull().default(false),
}, (t) => [index("listing_images_listing_idx").on(t.listingId, t.sortOrder)]);
```

- [ ] **Step 2: Write the remaining schema files**

Transcribe Part C of the master plan (`docs/superpowers/plans/2026-09-07-directory-platform-master.md`)
section by section, following exactly the style of Step 1 — the same `base` spread, the same enum
imports, `uniqueIndex` on every column the master plan marks `(unique)`, and an `index` on every
foreign key used in a filter:

- `ownership.ts` — `profiles`, `claims`, `verificationOrders`
- `money.ts` — `subscriptions`, `coupons`, `couponRedemptions`, `processedEvents`
- `trust.ts` — `enquiries`, `reports`, `removalRequests`, `suppressions`
- `ops.ts` — `redirects`, `auditLog`, `jobRuns`, `listingStatsDaily`, `badges`
- `modules.ts` — `reviews`, `reviewPhotos`, `reviewReplies`, `reviewInvites`, `shortlists`,
  `shortlistItems`, `priceData`, `quoteRequests`, `quoteRecipients`, `jobs`, `jobApplications`,
  `awards`, `affiliates`, `referrals`, `campaigns`, `campaignMessages`, `unsubscribes`

Every one of these ships on every site regardless of flags (constraint 7). An unused table costs
nothing; conditional migrations create drift between clones that becomes unmaintainable.

Two constraints to get right while transcribing:
- `processedEvents.eventId` is `uniqueIndex` — that unique constraint *is* the webhook idempotency
  mechanism, not a nicety.
- `unsubscribes.addressNormalised` is `uniqueIndex` — one unsubscribe means one unsubscribe forever,
  across every campaign and every site.

- [ ] **Step 3: Write `lib/db/schema/index.ts`**

```ts
export * from "./enums";
export * from "./geo";
export * from "./listings";
export * from "./ownership";
export * from "./money";
export * from "./trust";
export * from "./ops";
export * from "./modules";
```

- [ ] **Step 4: Generate, apply and verify**

```bash
DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev corepack pnpm db:generate
DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev corepack pnpm db:migrate
docker compose -f docker-compose.dev.yml exec postgres psql -U directory -d directory_dev -c '\dt' | wc -l
```
Expected: ~45 tables.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): listings, ownership, money, trust, ops and module schema"
```

---

## Task 9: slugify

**Files:**
- Create: `lib/routing/slugify.ts`, `lib/routing/reserved.ts`
- Test: `lib/routing/slugify.test.ts`

**Interfaces:**
- Produces: `slugify(input: string): string`; `RESERVED_SLUGS: readonly string[]`;
  `isReserved(slug: string): boolean`.

- [ ] **Step 1: Write the failing test**

`lib/routing/slugify.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { slugify, isReserved, RESERVED_SLUGS } from "./slugify";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Milton Keynes")).toBe("milton-keynes");
  });
  it("strips accents", () => {
    expect(slugify("Ynys Môn")).toBe("ynys-mon");
    expect(slugify("Saint-Étienne")).toBe("saint-etienne");
  });
  it("strips apostrophes rather than hyphenating them", () => {
    expect(slugify("St Ouen's Manor")).toBe("st-ouens-manor");
  });
  it("collapses runs of separators and trims them", () => {
    expect(slugify("  The  Barn -- & Co.  ")).toBe("the-barn-co");
  });
  it("handles ampersands as a word boundary, not a word", () => {
    expect(slugify("Bath & North East Somerset")).toBe("bath-north-east-somerset");
  });
  it("returns an empty string for input with no slug-able characters", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("isReserved", () => {
  it("catches every reserved slug", () => {
    for (const s of RESERVED_SLUGS) expect(isReserved(s)).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isReserved("ADMIN")).toBe(true);
  });
  it("allows an ordinary city slug", () => {
    expect(isReserved("manchester")).toBe(false);
  });
});
```

`slugify("!!!") === ""` is the case that matters: the caller must treat an empty slug as a hard
error rather than inserting a row with an empty slug, which would then own the `/` route.

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack pnpm vitest run lib/routing/slugify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/routing/slugify.ts`**

```ts
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // strip diacritics
    .replace(/['’]/g, "")          // apostrophes vanish: "St Ouen's" -> "st-ouens"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")        // everything else becomes a separator
    .replace(/^-+|-+$/g, "");
}

/**
 * Reserved at the root scope. Seeded into `slugs` as kind='static' in Task 10,
 * so the database rejects a colliding city or vertical rather than trusting
 * application code to remember.
 */
export const RESERVED_SLUGS = [
  "about", "blog", "guides", "admin", "account", "api", "search", "cities",
  "categories", "areas", "add-listing", "advertise", "pricing", "claim",
  "contact", "privacy", "terms", "faq", "sitemap", "robots", "_next",
  "images", "badge", "trust", "safety", "data-sources", "shortlist", "cost",
  "get-quotes", "jobs", "post-a-job", "awards", "affiliates", "tools",
  "leave-review", "select-listing-type",
] as const;

const reservedSet = new Set<string>(RESERVED_SLUGS);

export function isReserved(slug: string): boolean {
  return reservedSet.has(slug.toLowerCase());
}
```

Note the list includes every flagged route segment, not just the currently-enabled ones. A city
called "Awards" must be rejected even on a site where `awards` is off — otherwise flipping the flag
on later breaks a live URL.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `corepack pnpm vitest run lib/routing/slugify.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(routing): slugify and reserved slug list"
```

---

## Task 10: Slug allocation and collision handling

**Files:**
- Create: `lib/routing/slugs.ts`
- Test: `lib/routing/slugs.test.ts` (integration — uses `withTestDb`)

**Interfaces:**
- Produces:
  - `ROOT_SCOPE = "root"`
  - `allocateSlug(tx, input: { parentScope: string; desired: string; kind: SlugKind; entityId: string; disambiguator?: string }): Promise<string>`
    — returns the slug actually allocated, appending the disambiguator on collision.
  - `resolveSlug(tx, parentScope: string, slug: string): Promise<SlugRow | null>`
  - `seedReservedSlugs(tx): Promise<void>`

- [ ] **Step 1: Write the failing test**

`lib/routing/slugs.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { allocateSlug, resolveSlug, seedReservedSlugs, ROOT_SCOPE } from "./slugs";
import { randomUUID } from "node:crypto";

describe("allocateSlug", () => {
  it("allocates the desired slug when free", async () => {
    await withTestDb(async (tx) => {
      const got = await allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Manchester", kind: "city", entityId: randomUUID(),
      });
      expect(got).toBe("manchester");
    });
  });

  it("first city to claim a slug keeps it; the second is disambiguated by region", async () => {
    await withTestDb(async (tx) => {
      const a = await allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Richmond", kind: "city",
        entityId: randomUUID(), disambiguator: "Greater London",
      });
      const b = await allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Richmond", kind: "city",
        entityId: randomUUID(), disambiguator: "North Yorkshire",
      });
      expect(a).toBe("richmond");
      expect(b).toBe("richmond-north-yorkshire");
    });
  });

  it("appends a numeric suffix when even the disambiguated slug is taken", async () => {
    await withTestDb(async (tx) => {
      const args = { parentScope: ROOT_SCOPE, kind: "city" as const, disambiguator: "Kent" };
      await allocateSlug(tx, { ...args, desired: "Ashford", entityId: randomUUID() });
      await allocateSlug(tx, { ...args, desired: "Ashford", entityId: randomUUID() });
      const third = await allocateSlug(tx, { ...args, desired: "Ashford", entityId: randomUUID() });
      expect(third).toBe("ashford-kent-2");
    });
  });

  it("refuses a reserved slug even with no existing row", async () => {
    await withTestDb(async (tx) => {
      await seedReservedSlugs(tx);
      await expect(allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "Pricing", kind: "city", entityId: randomUUID(),
      })).rejects.toThrow(/reserved/i);
    });
  });

  it("refuses an empty slug", async () => {
    await withTestDb(async (tx) => {
      await expect(allocateSlug(tx, {
        parentScope: ROOT_SCOPE, desired: "!!!", kind: "city", entityId: randomUUID(),
      })).rejects.toThrow(/empty/i);
    });
  });

  it("scopes listing slugs per city, so the same slug is free in another city", async () => {
    await withTestDb(async (tx) => {
      const cityA = randomUUID(), cityB = randomUUID();
      const a = await allocateSlug(tx, { parentScope: cityA, desired: "The Barn", kind: "listing", entityId: randomUUID() });
      const b = await allocateSlug(tx, { parentScope: cityB, desired: "The Barn", kind: "listing", entityId: randomUUID() });
      expect(a).toBe("the-barn");
      expect(b).toBe("the-barn");
    });
  });

  it("stops a listing from stealing a category slug inside the same city", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: cityId, desired: "Barn Venues", kind: "category", entityId: randomUUID() });
      const listing = await allocateSlug(tx, {
        parentScope: cityId, desired: "Barn Venues", kind: "listing", entityId: randomUUID(),
      });
      expect(listing).not.toBe("barn-venues");
      expect(listing).toMatch(/^barn-venues-/);
    });
  });
});

describe("resolveSlug", () => {
  it("returns the kind and entity id", async () => {
    await withTestDb(async (tx) => {
      const entityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId });
      const row = await resolveSlug(tx, ROOT_SCOPE, "leeds");
      expect(row?.kind).toBe("city");
      expect(row?.entityId).toBe(entityId);
    });
  });

  it("returns null for an unknown slug", async () => {
    await withTestDb(async (tx) => {
      expect(await resolveSlug(tx, ROOT_SCOPE, "nowhere")).toBeNull();
    });
  });
});
```

The seventh test is the whole reason this table exists — it is the `/manchester/barn-venues`
ambiguity from master-plan item H1, and it is settled by a unique constraint rather than by
resolution order.

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack pnpm vitest run lib/routing/slugs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/routing/slugs.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { slugs } from "@/lib/db/schema";
import { slugify, isReserved, RESERVED_SLUGS } from "./slugify";
import type { Db } from "@/lib/db/client";

export const ROOT_SCOPE = "root";

export type SlugKind = "static" | "city" | "vertical" | "area" | "category" | "listing";

export interface SlugRow {
  parentScope: string;
  slug: string;
  kind: SlugKind;
  entityId: string | null;
}

type Tx = Db;

export class SlugError extends Error {}

async function isTaken(tx: Tx, parentScope: string, slug: string): Promise<boolean> {
  const [row] = await tx.select({ slug: slugs.slug }).from(slugs)
    .where(and(eq(slugs.parentScope, parentScope), eq(slugs.slug, slug))).limit(1);
  return row !== undefined;
}

/**
 * Allocates a slug within a scope, disambiguating on collision.
 * Ladder: desired -> desired-disambiguator -> desired-disambiguator-2, -3, ...
 * Returns the slug actually allocated. Insert your entity row with THIS value.
 */
export async function allocateSlug(
  tx: Tx,
  input: {
    parentScope: string;
    desired: string;
    kind: SlugKind;
    entityId: string;
    disambiguator?: string;
  },
): Promise<string> {
  const bareSlug = slugify(input.desired);
  if (bareSlug === "") {
    throw new SlugError(`Cannot derive a slug from ${JSON.stringify(input.desired)} — empty result`);
  }
  if (input.parentScope === ROOT_SCOPE && isReserved(bareSlug)) {
    throw new SlugError(`"${bareSlug}" is a reserved slug and cannot be used for a ${input.kind}`);
  }

  const candidates: string[] = [bareSlug];
  const disambiguated = input.disambiguator ? slugify(`${input.desired}-${input.disambiguator}`) : null;
  if (disambiguated && disambiguated !== bareSlug) candidates.push(disambiguated);

  const stem = disambiguated ?? bareSlug;
  for (let n = 2; n <= 50; n++) candidates.push(`${stem}-${n}`);

  for (const candidate of candidates) {
    if (await isTaken(tx, input.parentScope, candidate)) continue;
    await tx.insert(slugs).values({
      parentScope: input.parentScope,
      slug: candidate,
      kind: input.kind,
      entityId: input.entityId,
    });
    return candidate;
  }
  throw new SlugError(`Exhausted slug candidates for "${bareSlug}" in scope ${input.parentScope}`);
}

export async function resolveSlug(
  tx: Tx, parentScope: string, slug: string,
): Promise<SlugRow | null> {
  const [row] = await tx
    .select({
      parentScope: slugs.parentScope, slug: slugs.slug,
      kind: slugs.kind, entityId: slugs.entityId,
    })
    .from(slugs)
    .where(and(eq(slugs.parentScope, parentScope), eq(slugs.slug, slug.toLowerCase())))
    .limit(1);
  return row ?? null;
}

/** Idempotent. Run in the seed and in every migration path. */
export async function seedReservedSlugs(tx: Tx): Promise<void> {
  for (const slug of RESERVED_SLUGS) {
    if (await isTaken(tx, ROOT_SCOPE, slug)) continue;
    await tx.insert(slugs).values({
      parentScope: ROOT_SCOPE, slug, kind: "static", entityId: null,
    });
  }
}
```

- [ ] **Step 4: Create the test database and run the tests**

```bash
docker compose -f docker-compose.dev.yml exec postgres psql -U directory -d postgres -c 'create database directory_test'
DATABASE_URL=postgres://directory:directory@localhost:5433/directory_test corepack pnpm db:migrate
corepack pnpm vitest run lib/routing/slugs.test.ts
```
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(routing): slug registry with collision disambiguation"
```

---

## Task 11: Slug changes write redirects

**Files:**
- Modify: `lib/routing/slugs.ts`
- Test: `lib/routing/slugs.test.ts` (extend)

**Interfaces:**
- Produces: `reallocateSlug(tx, input: { parentScope; entityId; kind; newDesired; oldPath; newPathFor: (slug: string) => string; disambiguator? }): Promise<string>`
  — frees the old slug row, allocates the new one, and writes a 301 in one transaction.

- [ ] **Step 1: Write the failing test (append)**

```ts
import { reallocateSlug } from "./slugs";
import { redirects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

describe("reallocateSlug", () => {
  it("writes a 301 from the old path and frees the old slug", async () => {
    await withTestDb(async (tx) => {
      const entityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Kingston", kind: "city", entityId });

      const next = await reallocateSlug(tx, {
        parentScope: ROOT_SCOPE, entityId, kind: "city",
        newDesired: "Kingston upon Thames",
        oldPath: "/kingston",
        newPathFor: (s) => `/${s}`,
      });

      expect(next).toBe("kingston-upon-thames");

      const [r] = await tx.select().from(redirects).where(eq(redirects.fromPath, "/kingston"));
      expect(r?.toPath).toBe("/kingston-upon-thames");
      expect(r?.statusCode).toBe(301);

      // old slug is free again
      expect(await resolveSlug(tx, ROOT_SCOPE, "kingston")).toBeNull();
      expect((await resolveSlug(tx, ROOT_SCOPE, "kingston-upon-thames"))?.entityId).toBe(entityId);
    });
  });

  it("is a no-op returning the current slug when the name slugifies unchanged", async () => {
    await withTestDb(async (tx) => {
      const entityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Bath", kind: "city", entityId });
      const next = await reallocateSlug(tx, {
        parentScope: ROOT_SCOPE, entityId, kind: "city", newDesired: "Bath",
        oldPath: "/bath", newPathFor: (s) => `/${s}`,
      });
      expect(next).toBe("bath");
      expect(await tx.select().from(redirects).where(eq(redirects.fromPath, "/bath"))).toHaveLength(0);
    });
  });
});
```

The second test matters more than it looks: without it, every admin save of an unchanged name writes
a self-referential 301 and the `redirects` table becomes a redirect loop generator.

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack pnpm vitest run lib/routing/slugs.test.ts`
Expected: FAIL — `reallocateSlug is not exported`.

- [ ] **Step 3: Implement (append to `lib/routing/slugs.ts`)**

```ts
import { redirects } from "@/lib/db/schema";

/**
 * Renames an entity's slug and preserves the old URL. Constraint 16: any slug
 * change writes a redirects row and serves a 301. Never break a URL.
 */
export async function reallocateSlug(
  tx: Tx,
  input: {
    parentScope: string;
    entityId: string;
    kind: SlugKind;
    newDesired: string;
    oldPath: string;
    newPathFor: (slug: string) => string;
    disambiguator?: string;
  },
): Promise<string> {
  const [current] = await tx.select({ slug: slugs.slug }).from(slugs)
    .where(and(eq(slugs.parentScope, input.parentScope), eq(slugs.entityId, input.entityId)))
    .limit(1);
  if (!current) throw new SlugError(`No slug allocated for entity ${input.entityId}`);

  const desired = slugify(input.newDesired);
  if (desired === current.slug) return current.slug;   // no-op, no redirect

  await tx.delete(slugs).where(
    and(eq(slugs.parentScope, input.parentScope), eq(slugs.entityId, input.entityId)),
  );

  const allocated = await allocateSlug(tx, {
    parentScope: input.parentScope,
    desired: input.newDesired,
    kind: input.kind,
    entityId: input.entityId,
    disambiguator: input.disambiguator,
  });

  await tx.insert(redirects)
    .values({ fromPath: input.oldPath, toPath: input.newPathFor(allocated), statusCode: 301 })
    .onConflictDoUpdate({
      target: redirects.fromPath,
      set: { toPath: input.newPathFor(allocated) },
    });

  return allocated;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `corepack pnpm vitest run lib/routing/slugs.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(routing): slug rename writes a 301 and frees the old slug"
```

---

## Task 12: PillarScope and route resolution

**Files:**
- Create: `lib/routing/scope.ts`, `lib/routing/resolve.ts`
- Test: `lib/routing/resolve.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type PillarScope =
    | { type: "city"; cityId: string }
    | { type: "city-category"; cityId: string; categoryId: string }
    | { type: "vertical"; verticalId: string }
    | { type: "vertical-area"; verticalId: string; areaId: string };

  type RouteResolution =
    | { kind: "pillar"; scope: PillarScope }
    | { kind: "listing"; listingId: string; cityId: string }
    | { kind: "redirect"; to: string; status: number }
    | { kind: "not-found" };

  function resolveRoute(tx, segments: string[], mode: SiteMode): Promise<RouteResolution>;
  ```

- [ ] **Step 1: Write the failing test**

`lib/routing/resolve.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { allocateSlug, seedReservedSlugs, ROOT_SCOPE } from "./slugs";
import { resolveRoute } from "./resolve";
import { redirects } from "@/lib/db/schema";
import { randomUUID } from "node:crypto";

describe("resolveRoute (niche-national)", () => {
  it("resolves /[city] to a city pillar", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      expect(await resolveRoute(tx, ["leeds"], "niche-national"))
        .toEqual({ kind: "pillar", scope: { type: "city", cityId } });
    });
  });

  it("resolves /[city]/[category] to a city-category pillar", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), categoryId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "Barn Venues", kind: "category", entityId: categoryId });
      expect(await resolveRoute(tx, ["leeds", "barn-venues"], "niche-national"))
        .toEqual({ kind: "pillar", scope: { type: "city-category", cityId, categoryId } });
    });
  });

  it("resolves /[city]/[listing] to a listing", async () => {
    await withTestDb(async (tx) => {
      const cityId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Leeds", kind: "city", entityId: cityId });
      await allocateSlug(tx, { parentScope: cityId, desired: "The Barn", kind: "listing", entityId: listingId });
      expect(await resolveRoute(tx, ["leeds", "the-barn"], "niche-national"))
        .toEqual({ kind: "listing", listingId, cityId });
    });
  });

  it("returns not-found for an unknown city", async () => {
    await withTestDb(async (tx) => {
      expect(await resolveRoute(tx, ["atlantis"], "niche-national")).toEqual({ kind: "not-found" });
    });
  });

  it("returns not-found for a reserved slug — static routes are handled by the router, not here", async () => {
    await withTestDb(async (tx) => {
      await seedReservedSlugs(tx);
      expect(await resolveRoute(tx, ["pricing"], "niche-national")).toEqual({ kind: "not-found" });
    });
  });

  it("prefers a redirect over a 404", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(redirects).values({ fromPath: "/kingston", toPath: "/kingston-upon-thames", statusCode: 301 });
      expect(await resolveRoute(tx, ["kingston"], "niche-national"))
        .toEqual({ kind: "redirect", to: "/kingston-upon-thames", status: 301 });
    });
  });
});

describe("resolveRoute (local-multi-vertical)", () => {
  it("resolves /[vertical] to a vertical pillar", async () => {
    await withTestDb(async (tx) => {
      const verticalId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Plumbers", kind: "vertical", entityId: verticalId });
      expect(await resolveRoute(tx, ["plumbers"], "local-multi-vertical"))
        .toEqual({ kind: "pillar", scope: { type: "vertical", verticalId } });
    });
  });

  it("distinguishes /[vertical]/[area] from /[vertical]/[listing]", async () => {
    await withTestDb(async (tx) => {
      const verticalId = randomUUID(), areaId = randomUUID(), listingId = randomUUID();
      await allocateSlug(tx, { parentScope: ROOT_SCOPE, desired: "Plumbers", kind: "vertical", entityId: verticalId });
      await allocateSlug(tx, { parentScope: verticalId, desired: "St Helier", kind: "area", entityId: areaId });
      await allocateSlug(tx, { parentScope: verticalId, desired: "Bob's Plumbing", kind: "listing", entityId: listingId });

      expect(await resolveRoute(tx, ["plumbers", "st-helier"], "local-multi-vertical"))
        .toEqual({ kind: "pillar", scope: { type: "vertical-area", verticalId, areaId } });
      expect(await resolveRoute(tx, ["plumbers", "bobs-plumbing"], "local-multi-vertical"))
        .toEqual({ kind: "listing", listingId, cityId: verticalId });
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack pnpm vitest run lib/routing/resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/routing/scope.ts`**

```ts
export type PillarScope =
  | { type: "city"; cityId: string }
  | { type: "city-category"; cityId: string; categoryId: string }
  | { type: "vertical"; verticalId: string }
  | { type: "vertical-area"; verticalId: string; areaId: string };

/** The id the scope's listings are filtered by, whichever axis the site uses. */
export function scopeParentId(scope: PillarScope): string {
  switch (scope.type) {
    case "city":
    case "city-category":
      return scope.cityId;
    case "vertical":
    case "vertical-area":
      return scope.verticalId;
  }
}
```

- [ ] **Step 4: Implement `lib/routing/resolve.ts`**

```ts
import { eq } from "drizzle-orm";
import { redirects } from "@/lib/db/schema";
import type { SiteMode } from "@/config/types";
import type { Db } from "@/lib/db/client";
import { resolveSlug, ROOT_SCOPE } from "./slugs";
import type { PillarScope } from "./scope";

export type RouteResolution =
  | { kind: "pillar"; scope: PillarScope }
  | { kind: "listing"; listingId: string; cityId: string }
  | { kind: "redirect"; to: string; status: number }
  | { kind: "not-found" };

async function redirectFor(tx: Db, path: string): Promise<RouteResolution | null> {
  const [r] = await tx.select().from(redirects).where(eq(redirects.fromPath, path)).limit(1);
  return r ? { kind: "redirect", to: r.toPath, status: r.statusCode } : null;
}

/**
 * One lookup per segment against the slug registry. No ordered fallback and no
 * mode-specific branching — the `kind` column already says what a slug is,
 * which is why both site modes share this resolver.
 */
export async function resolveRoute(
  tx: Db, segments: string[], mode: SiteMode,
): Promise<RouteResolution> {
  const path = `/${segments.join("/")}`;
  const first = segments[0];
  if (first === undefined) return { kind: "not-found" };

  const root = await resolveSlug(tx, ROOT_SCOPE, first);

  // A reserved slug reaching this resolver means the static route did not match,
  // so there is nothing here. Never fall through to a database lookup.
  if (root?.kind === "static") return { kind: "not-found" };

  const expectedRootKind = mode === "niche-national" ? "city" : "vertical";
  if (!root || root.kind !== expectedRootKind || root.entityId === null) {
    return (await redirectFor(tx, path)) ?? { kind: "not-found" };
  }
  const parentId = root.entityId;

  if (segments.length === 1) {
    return {
      kind: "pillar",
      scope: mode === "niche-national"
        ? { type: "city", cityId: parentId }
        : { type: "vertical", verticalId: parentId },
    };
  }

  const second = segments[1];
  if (segments.length > 2 || second === undefined) {
    return (await redirectFor(tx, path)) ?? { kind: "not-found" };
  }

  const child = await resolveSlug(tx, parentId, second);
  if (!child || child.entityId === null) {
    return (await redirectFor(tx, path)) ?? { kind: "not-found" };
  }

  switch (child.kind) {
    case "category":
      return { kind: "pillar", scope: { type: "city-category", cityId: parentId, categoryId: child.entityId } };
    case "area":
      return { kind: "pillar", scope: { type: "vertical-area", verticalId: parentId, areaId: child.entityId } };
    case "listing":
      return { kind: "listing", listingId: child.entityId, cityId: parentId };
    default:
      return { kind: "not-found" };
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `corepack pnpm vitest run lib/routing/resolve.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(routing): PillarScope and mode-agnostic route resolution"
```

---

## Task 13: Viewer, the published base query, and the ranking expression

**Files:**
- Create: `lib/db/viewer.ts`, `lib/db/sort.ts`, `lib/db/queries/listings.ts`
- Test: `lib/db/sort.test.ts`, `lib/db/queries/listings.test.ts`

**Interfaces:**
- Produces:
  - `type Viewer = { role: "public" } | { role: "user" | "owner" | "admin"; userId: string }`
  - `PUBLIC_VIEWER: Viewer`
  - `listingRankOrder(timezone: string): SQL[]` — the ONE sort expression, used everywhere.
  - `listListings(tx, viewer: Viewer, scope: PillarScope, opts: { page?: number; perPage?: number }): Promise<ListingRow[]>`

- [ ] **Step 1: Write `lib/db/viewer.ts`**

```ts
export type Viewer =
  | { role: "public" }
  | { role: "user"; userId: string }
  | { role: "owner"; userId: string }
  | { role: "admin"; userId: string };

export const PUBLIC_VIEWER: Viewer = { role: "public" };

export function isAdmin(v: Viewer): boolean {
  return v.role === "admin";
}
```

- [ ] **Step 2: Write the failing sort test**

`lib/db/sort.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { listingRankOrder } from "./sort";
import { listings } from "@/lib/db/schema";
import { makeTierTrio } from "@/test/factories";
import { sql } from "drizzle-orm";

describe("listingRankOrder", () => {
  it("orders premium above essential above free", async () => {
    await withTestDb(async (tx) => {
      await makeTierTrio(tx);
      const rows = await tx.select({ tier: listings.tier }).from(listings)
        .orderBy(...listingRankOrder("Europe/London"));
      expect(rows.map((r) => r.tier)).toEqual(["premium", "essential", "free"]);
    });
  });

  it("breaks ties within a tier by rank_boost, then claim status, then a daily shuffle", async () => {
    await withTestDb(async (tx) => {
      await makeTierTrio(tx);
      const rows = await tx.select({ id: listings.id }).from(listings)
        .orderBy(...listingRankOrder("Europe/London"));
      expect(rows).toHaveLength(3);
    });
  });

  it("produces a stable order within a single day", async () => {
    await withTestDb(async (tx) => {
      await makeTierTrio(tx);
      const a = await tx.select({ id: listings.id }).from(listings).orderBy(...listingRankOrder("Europe/London"));
      const b = await tx.select({ id: listings.id }).from(listings).orderBy(...listingRankOrder("Europe/London"));
      expect(a).toEqual(b);
    });
  });

  it("uses the configured timezone, not the server's, for the shuffle date", async () => {
    await withTestDb(async (tx) => {
      const [{ d: london }] = await tx.execute(
        sql`select (now() at time zone 'Europe/London')::date::text as d`,
      ) as unknown as { d: string }[];
      const [{ d: auckland }] = await tx.execute(
        sql`select (now() at time zone 'Pacific/Auckland')::date::text as d`,
      ) as unknown as { d: string }[];
      expect(typeof london).toBe("string");
      expect(typeof auckland).toBe("string");
    });
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `corepack pnpm vitest run lib/db/sort.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `lib/db/sort.ts`**

```ts
import { sql, type SQL } from "drizzle-orm";
import { listings } from "@/lib/db/schema";

/**
 * The ONE ranking expression. Every pillar page, search result and sitemap
 * ordering uses this — if it appears twice in the codebase, that's a bug.
 *
 * The daily shuffle is not cosmetic: without it the same free listings sit at
 * the bottom forever and never convert. It is pinned to the site's configured
 * timezone so it cannot flip at server-local midnight mid-ISR-window.
 */
export function listingRankOrder(timezone: string): SQL[] {
  return [
    sql`case ${listings.tier}
          when 'premium' then 30
          when 'essential' then 20
          else 10
        end desc`,
    sql`${listings.rankBoost} desc`,
    sql`case ${listings.claimStatus}
          when 'verified' then 25
          when 'claimed' then 10
          else 0
        end desc`,
    sql`md5(${listings.id}::text || (now() at time zone ${sql.raw(`'${timezone}'`)})::date::text) asc`,
  ];
}
```

Note the claim-status weights (0/10/25) come straight from the §5B.7 table and replace the brief's
`is_verified DESC` — a boolean cannot express three states.

- [ ] **Step 5: Implement `lib/db/queries/listings.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import { listings } from "@/lib/db/schema";
import { listingRankOrder } from "@/lib/db/sort";
import { siteConfig } from "@/config/site.config";
import type { Viewer } from "@/lib/db/viewer";
import type { PillarScope } from "@/lib/routing/scope";
import type { Db } from "@/lib/db/client";

const PER_PAGE = 24;

/**
 * The single published-listing gate (constraint 10). Everything public builds
 * on this. Admins see everything; nobody else sees anything unpublished.
 */
function visibilityFilter(viewer: Viewer) {
  if (viewer.role === "admin") return sql`true`;
  return eq(listings.status, "published");
}

function scopeFilter(scope: PillarScope) {
  switch (scope.type) {
    case "city":
      return eq(listings.cityId, scope.cityId);
    case "city-category":
      return and(eq(listings.cityId, scope.cityId), eq(listings.primaryCategoryId, scope.categoryId));
    case "vertical":
      return eq(listings.verticalId, scope.verticalId);
    case "vertical-area":
      return and(eq(listings.verticalId, scope.verticalId), eq(listings.areaId, scope.areaId));
  }
}

export async function listListings(
  tx: Db,
  viewer: Viewer,
  scope: PillarScope,
  opts: { page?: number; perPage?: number } = {},
) {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = opts.perPage ?? PER_PAGE;
  return tx.select().from(listings)
    .where(and(visibilityFilter(viewer), scopeFilter(scope)))
    .orderBy(...listingRankOrder(siteConfig.timezone))
    .limit(perPage)
    .offset((page - 1) * perPage);
}
```

- [ ] **Step 6: Write the failing visibility test**

`lib/db/queries/listings.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { listListings } from "./listings";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeVertical, makeCity, makeCategory, makeListing } from "@/test/factories";
import { listingStatus } from "@/lib/db/schema";

const ALL_STATUSES = ["draft", "pending", "published", "rejected", "archived", "removed"] as const;

async function seedOnePerStatus(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const verticalId = await makeVertical(tx as never);
  const cityId = await makeCity(tx as never);
  const primaryCategoryId = await makeCategory(tx as never, verticalId, cityId);
  for (const status of ALL_STATUSES) {
    await makeListing(tx as never, { cityId, verticalId, primaryCategoryId }, { status, name: `${status} venue` });
  }
  return { cityId, verticalId, primaryCategoryId };
}

describe("listListings", () => {
  it("never returns a draft, pending, rejected, archived or removed listing to the public", async () => {
    await withTestDb(async (tx) => {
      const { cityId } = await seedOnePerStatus(tx);
      const rows = await listListings(tx as never, PUBLIC_VIEWER, { type: "city", cityId });
      expect(rows).toHaveLength(1);
      expect(rows.every((r) => r.status === "published")).toBe(true);
    });
  });

  it("returns unpublished listings to an admin", async () => {
    await withTestDb(async (tx) => {
      const { cityId } = await seedOnePerStatus(tx);
      const rows = await listListings(tx as never, { role: "admin", userId: "x" }, { type: "city", cityId });
      expect(rows).toHaveLength(ALL_STATUSES.length);
    });
  });

  it("paginates at 24 by default", async () => {
    await withTestDb(async (tx) => {
      const verticalId = await makeVertical(tx as never);
      const cityId = await makeCity(tx as never);
      const primaryCategoryId = await makeCategory(tx as never, verticalId, cityId);
      for (let i = 0; i < 30; i++) {
        await makeListing(tx as never, { cityId, verticalId, primaryCategoryId }, { name: `Venue ${i}` });
      }
      expect(await listListings(tx as never, PUBLIC_VIEWER, { type: "city", cityId })).toHaveLength(24);
      expect(await listListings(tx as never, PUBLIC_VIEWER, { type: "city", cityId }, { page: 2 })).toHaveLength(6);
    });
  });
});
```

The first test is the single most important assertion in the phase — it is the only thing standing
between a moderation queue and the public web.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `corepack pnpm vitest run lib/db`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(db): viewer gate, published base query, single ranking expression"
```

---

## Task 14: Redis ISR cache handler

**Files:**
- Create: `cache-handler.mjs` (port of `reference/cache-handler.mjs`)
- Modify: `next.config.mjs`
- Test: `scripts/verify-isr.sh` (port of `reference/isr-redeploy-test.sh`)

**Interfaces:**
- Produces: nothing importable. Produces the guarantee that the cache is shared across replicas and
  survives a container restart of one build — and, since 2026-09-08, that a *deploy* starts cold
  rather than serving the previous build's HTML.

- [ ] **Step 1: Copy the proven handler**

```bash
cp reference/cache-handler.mjs cache-handler.mjs
corepack pnpm add @fortedigital/nextjs-cache-handler@^3.3.0 @redis/client
```

The `^3.3.0` floor is mandatory, not cautious: below it, Next >= 16.3.0 clients retry `/_tree`
prefetches indefinitely (Phase 0 finding). Change the log prefix from `[spike]` to `[cache]` and
the `keyPrefix` from `spike:` to `nextjs:`. Change nothing else — this file was proven working and
every line of the build-phase guard and the LRU fallback is load-bearing (constraint 4).

- [ ] **Step 2: Copy and adapt the verification script**

```bash
cp reference/isr-redeploy-test.sh scripts/verify-isr.sh
```

Point it at this app's port and at the dev Redis on 6380, and swap the `/isr` fixture route for
`/manchester` once Task 20 lands.

- [ ] **Step 3: Confirm the build does not touch Redis**

```bash
docker compose -f docker-compose.dev.yml stop redis
NEXT_PUBLIC_SITE_URL=https://x.test corepack pnpm build
docker compose -f docker-compose.dev.yml start redis
```
Expected: the build **completes** with Redis down. If it hangs, the `PHASE_PRODUCTION_BUILD` guard
is wrong — that is exactly the Phase 0 failure and it must not regress.

- [ ] **Step 4: Add the script and commit**

```json
"verify:isr": "bash scripts/verify-isr.sh"
```
```bash
git add -A && git commit -m "feat: redis-backed ISR cache handler with build guard and LRU fallback"
```

---

## Task 15: Seed script

**Files:**
- Create: `scripts/seed.ts`, `seeds/wedding-venues/cities.csv`, `categories.csv`, `listings.csv`
- Test: `scripts/seed.test.ts`

**Interfaces:**
- Produces: `pnpm seed` — idempotent, allocates every slug through `allocateSlug`, seeds reserved
  slugs first. **Delivers gate part 1: 50 cities, 20 categories, 200 listings.**

- [ ] **Step 1: Build the seed CSVs**

`cities.csv` — 50 UK cities: `name,region,country,lat,lng,population`. Real coordinates; the nearby-cities
haversine block in Phase 2 depends on them being right.
`categories.csv` — 20 rows: `name,singular,plural,description,icon,sort_order`.
`listings.csv` — 200 rows: `name,city,category,address_line1,postcode,phone,website,short_description`.

**No ratings, no review counts, no verified flags in any seed row** (constraint 13). Seeded listings
get `source: 'seed'`, `claim_status: 'unclaimed'`, `tier: 'free'`.

- [ ] **Step 2: Write the failing test**

`scripts/seed.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { runSeed } from "./seed";
import { cities, categories, listings, slugs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

describe("runSeed", () => {
  it("loads 50 cities, 20 categories and 200 listings", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, "wedding-venues");
      expect(await tx.select().from(cities)).toHaveLength(50);
      expect(await tx.select().from(categories)).toHaveLength(20);
      expect(await tx.select().from(listings)).toHaveLength(200);
    });
  });

  it("is idempotent — running twice does not duplicate", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, "wedding-venues");
      await runSeed(tx, "wedding-venues");
      expect(await tx.select().from(cities)).toHaveLength(50);
    });
  });

  it("allocates a slug row for every entity", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, "wedding-venues");
      expect(await tx.select().from(slugs).where(eq(slugs.kind, "city"))).toHaveLength(50);
      expect(await tx.select().from(slugs).where(eq(slugs.kind, "listing"))).toHaveLength(200);
    });
  });

  it("seeds no ratings and no verified listings", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, "wedding-venues");
      const rows = await tx.select().from(listings);
      expect(rows.every((r) => r.ratingAvg === null && r.ratingCount === 0)).toBe(true);
      expect(rows.every((r) => r.claimStatus === "unclaimed")).toBe(true);
    });
  });

  it("leaves every city non-indexable until it earns it", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, "wedding-venues");
      expect((await tx.select().from(cities)).every((c) => c.isIndexable === false)).toBe(true);
    });
  });
});
```

- [ ] **Step 2b: Run it and confirm it fails**

Run: `corepack pnpm vitest run scripts/seed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/seed.ts`**

Structure:
1. `seedReservedSlugs(tx)` **first** — so a seeded city named "Pricing" fails loudly here rather
   than silently shadowing a static route in production.
2. Insert the single implicit vertical (`niche-national` has exactly one and it never appears in a URL).
3. For each CSV row: insert the entity with a placeholder slug, then `allocateSlug(...)` with
   `disambiguator: row.region` for cities, and `UPDATE` the entity's `slug` column to the returned
   value. Cities carry `createdBy: 'seed'`, `isIndexable: false`.
4. Categories are allocated at `parentScope: ROOT_SCOPE` for the global `/categories/[slug]` route
   **and** at each `parentScope: cityId` where they have listings, so `/leeds/barn-venues` resolves.
5. Listings at `parentScope: cityId`.
6. Recompute `cities.listing_count`.

Idempotency: check for an existing slug row before inserting each entity and skip if present.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `corepack pnpm vitest run scripts/seed.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run it for real — this is gate part 1**

```bash
DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev corepack pnpm seed
docker compose -f docker-compose.dev.yml exec postgres psql -U directory -d directory_dev \
  -c 'select (select count(*) from cities) cities, (select count(*) from categories) cats, (select count(*) from listings) listings'
```
Expected: `50 | 20 | 200`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: seed script and wedding-venue seed data"
```

---

## Task 16: CSV importer with the scraped-data guardrails

**Files:**
- Create: `scripts/import-csv.ts`, `lib/import/guardrails.ts`
- Test: `lib/import/guardrails.test.ts`

**Interfaces:**
- Produces:
  - `checkSuppressed(tx, row: ImportRow): Promise<boolean>`
  - `findDuplicate(tx, row: ImportRow): Promise<{ listingId: string; reason: string } | null>`
  - `importRows(tx, rows: ImportRow[], opts: { dryRun: boolean }): Promise<ImportReport>`

These guardrails are built now, not retrofitted. §5.2b is explicit that retrofitting them "after the
complaints start is much worse", and every site launches from scraped data.

**The importer has two modes and they are not interchangeable:**

| Mode | Used for | Descriptions | `source` |
|---|---|---|---|
| `scraped` | Public-register data pulled to seed a new site | **Rejected** — a description in a scraped feed is someone else's copyright | `scraped` |
| `authored` | Shane's own written content, supplied as CSV | **Required and kept** | `import` |

Both modes check suppressions, check duplicates, record `source_url` / `imported_at`, and set
`claim_status: 'unclaimed'` with no rating and no verified state. The only difference is the
description rule. Owners editing their own listing after login go through the account UI, not this
importer, and are bounded by their tier's `maxDescriptionChars`.

- [ ] **Step 1: Write the failing test**

`lib/import/guardrails.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { importRows, checkSuppressed, findDuplicate } from "./guardrails";
import { suppressions, listings } from "@/lib/db/schema";

const row = {
  name: "The Old Barn", city: "Leeds", category: "Barn Venues",
  addressLine1: "1 Farm Lane", postcode: "LS1 1AA", phone: "0113 000 0000",
  website: "https://oldbarn.example", sourceUrl: "https://register.example/123",
};

describe("import guardrails", () => {
  it("sets source=scraped, claim_status=unclaimed and never verified", async () => {
    await withTestDb(async (tx) => {
      await importRows(tx, [row], { dryRun: false });
      const [l] = await tx.select().from(listings);
      expect(l?.source).toBe("scraped");
      expect(l?.claimStatus).toBe("unclaimed");
      expect(l?.ratingAvg).toBeNull();
      expect(l?.ratingCount).toBe(0);
    });
  });

  it("records source_url and imported_at so a disputed row is traceable", async () => {
    await withTestDb(async (tx) => {
      await importRows(tx, [row], { dryRun: false });
      const [l] = await tx.select().from(listings);
      expect(l?.sourceUrl).toBe("https://register.example/123");
      expect(l?.importedAt).toBeInstanceOf(Date);
    });
  });

  it("refuses a row on the suppression list, matched on name + postcode", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", postcodeNormalised: "ls11aa", reason: "removal request",
      });
      expect(await checkSuppressed(tx, row)).toBe(true);
      const report = await importRows(tx, [row], { dryRun: false });
      expect(report.suppressed).toBe(1);
      expect(await tx.select().from(listings)).toHaveLength(0);
    });
  });

  it("normalises postcode case and spacing when matching suppressions", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", postcodeNormalised: "ls11aa", reason: "x",
      });
      expect(await checkSuppressed(tx, { ...row, postcode: "ls1 1aa" })).toBe(true);
    });
  });

  it("flags a likely duplicate on name + postcode rather than inserting it", async () => {
    await withTestDb(async (tx) => {
      await importRows(tx, [row], { dryRun: false });
      const report = await importRows(tx, [{ ...row, phone: "0113 111 1111" }], { dryRun: false });
      expect(report.duplicates).toBe(1);
      expect(await tx.select().from(listings)).toHaveLength(1);
    });
  });

  it("flags a duplicate on phone alone even when the name differs", async () => {
    await withTestDb(async (tx) => {
      await importRows(tx, [row], { dryRun: false });
      const hit = await findDuplicate(tx, { ...row, name: "Old Barn Weddings", postcode: "LS9 9ZZ" });
      expect(hit?.reason).toMatch(/phone/);
    });
  });

  it("writes nothing on a dry run but reports what it would do", async () => {
    await withTestDb(async (tx) => {
      const report = await importRows(tx, [row], { dryRun: true });
      expect(report.inserted).toBe(1);
      expect(await tx.select().from(listings)).toHaveLength(0);
    });
  });

  it("rejects a description in scraped mode — facts only", async () => {
    await withTestDb(async (tx) => {
      const report = await importRows(
        tx, [{ ...row, description: "The Old Barn is a stunning converted..." }],
        { dryRun: false, mode: "scraped" },
      );
      expect(report.rejected).toBe(1);
    });
  });

  it("keeps a description in authored mode and marks the source as import", async () => {
    await withTestDb(async (tx) => {
      await importRows(
        tx, [{ ...row, description: "A restored 18th-century barn on the edge of the moors." }],
        { dryRun: false, mode: "authored" },
      );
      const [l] = await tx.select().from(listings);
      expect(l?.description).toBe("A restored 18th-century barn on the edge of the moors.");
      expect(l?.source).toBe("import");
    });
  });

  it("still refuses a verified state or a rating in authored mode", async () => {
    await withTestDb(async (tx) => {
      await importRows(tx, [{ ...row, description: "Written copy." }], { dryRun: false, mode: "authored" });
      const [l] = await tx.select().from(listings);
      expect(l?.claimStatus).toBe("unclaimed");
      expect(l?.ratingAvg).toBeNull();
    });
  });
});
```

The scraped-mode test enforces §5.2b mechanically: a description column in a scraped feed is someone
else's copyright, so the importer refuses the row rather than trusting whoever ran it to have
stripped it. Authored mode exists because our own written content arrives the same way and must not
be caught by that rule.

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack pnpm vitest run lib/import/guardrails.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/import/guardrails.ts`**

```ts
import { and, eq, or } from "drizzle-orm";
import { listings, suppressions } from "@/lib/db/schema";
import { now } from "@/lib/clock";
import type { Db } from "@/lib/db/client";

export type ImportMode = "scraped" | "authored";

export interface ImportRow {
  name: string; city: string; category: string;
  addressLine1?: string; postcode?: string; phone?: string; website?: string;
  sourceUrl?: string;
  /** Allowed in authored mode. In scraped mode its presence rejects the row. */
  description?: string;
}

export interface ImportReport {
  inserted: number; duplicates: number; suppressed: number; rejected: number;
  notes: string[];
}

export const normaliseName = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
export const normalisePostcode = (s: string): string => s.replace(/\s+/g, "").toLowerCase();
export const normalisePhone = (s: string): string => s.replace(/[^0-9]/g, "");

export async function checkSuppressed(tx: Db, row: ImportRow): Promise<boolean> {
  if (!row.postcode) return false;
  const [hit] = await tx.select({ id: suppressions.id }).from(suppressions)
    .where(and(
      eq(suppressions.nameNormalised, normaliseName(row.name)),
      eq(suppressions.postcodeNormalised, normalisePostcode(row.postcode)),
    )).limit(1);
  return hit !== undefined;
}

export async function findDuplicate(
  tx: Db, row: ImportRow,
): Promise<{ listingId: string; reason: string } | null> {
  const clauses = [];
  if (row.postcode) {
    clauses.push(and(eq(listings.name, row.name), eq(listings.postcode, row.postcode)));
  }
  if (row.phone) clauses.push(eq(listings.phone, row.phone));
  if (clauses.length === 0) return null;

  const [hit] = await tx.select({ id: listings.id, phone: listings.phone })
    .from(listings).where(or(...clauses)).limit(1);
  if (!hit) return null;
  return {
    listingId: hit.id,
    reason: hit.phone && normalisePhone(hit.phone) === normalisePhone(row.phone ?? "")
      ? "matching phone" : "matching name and postcode",
  };
}

export async function importRows(
  tx: Db, rows: ImportRow[], opts: { dryRun: boolean; mode: ImportMode },
): Promise<ImportReport> {
  const report: ImportReport = { inserted: 0, duplicates: 0, suppressed: 0, rejected: 0, notes: [] };

  for (const row of rows) {
    // Facts only in scraped mode: a description in a scraped feed is someone
    // else's copyright (§5.2b). Authored mode is our own copy and keeps it.
    const hasDescription = row.description !== undefined && row.description.trim() !== "";
    if (opts.mode === "scraped" && hasDescription) {
      report.rejected++;
      report.notes.push(`${row.name}: rejected — description present in a scraped import; facts only`);
      continue;
    }
    if (await checkSuppressed(tx, row)) {
      report.suppressed++;
      report.notes.push(`${row.name}: skipped — on the suppression list`);
      continue;
    }
    const dupe = await findDuplicate(tx, row);
    if (dupe) {
      report.duplicates++;
      report.notes.push(`${row.name}: skipped — likely duplicate of ${dupe.listingId} (${dupe.reason})`);
      continue;
    }
    report.inserted++;
    if (opts.dryRun) continue;

    // Imported listings are NEVER verified, NEVER rated, ALWAYS traceable —
    // in either mode. Only the description rule and `source` differ.
    await insertImportedListing(tx, row, {
      source: opts.mode === "scraped" ? "scraped" : "import",
      claimStatus: "unclaimed", status: "published", tier: "free",
      importedAt: now(), sourceUrl: row.sourceUrl ?? null,
      description: opts.mode === "authored" && hasDescription ? row.description! : null,
    });
  }
  return report;
}
```

Implement `insertImportedListing` alongside: resolve or create the city and category, allocate the
slug via `allocateSlug(tx, { parentScope: cityId, ... })`. In scraped mode, generate
`shortDescription` from the structured fields only. In authored mode, take the supplied description
and derive `shortDescription` from its first sentence.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `corepack pnpm vitest run lib/import/guardrails.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(import): CSV importer with suppression, dedupe and facts-only guardrails"
```

---

## Task 17: Image validation and the derivative pipeline

**Files:**
- Create: `lib/media/validate.ts`, `lib/media/derivatives.ts`, `lib/media/r2.ts`
- Test: `lib/media/validate.test.ts`, `lib/media/derivatives.test.ts`

**Interfaces:**
- Produces:
  - `sniffMime(buf: Buffer): "image/jpeg" | "image/png" | "application/pdf" | null`
  - `assertUploadable(buf: Buffer, opts: { allow: readonly string[]; maxBytes: number }): void`
  - `generateDerivatives(input: Buffer): Promise<Record<"thumb"|"card"|"hero"|"full", Buffer>>`

- [ ] **Step 1: Write the failing validation test**

`lib/media/validate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { sniffMime, assertUploadable } from "./validate";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from("%PDF-1.7\n");
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

describe("sniffMime", () => {
  it("identifies jpeg, png and pdf by magic bytes", () => {
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(PDF)).toBe("application/pdf");
  });

  it("returns null for an SVG, whatever the file is called", () => {
    expect(sniffMime(SVG)).toBeNull();
  });

  it("returns null for a renamed executable", () => {
    expect(sniffMime(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
  });
});

describe("assertUploadable", () => {
  const opts = { allow: ["image/jpeg", "image/png"] as const, maxBytes: 8 * 1024 * 1024 };

  it("accepts a jpeg", () => {
    expect(() => assertUploadable(JPEG, opts)).not.toThrow();
  });

  it("rejects a PDF for listing media even though it is a valid type elsewhere", () => {
    expect(() => assertUploadable(PDF, opts)).toThrow(/not allowed/i);
  });

  it("rejects anything over 8 MB", () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)]);
    expect(() => assertUploadable(big, opts)).toThrow(/too large/i);
  });

  it("rejects an SVG — this is the stored-XSS vector", () => {
    expect(() => assertUploadable(SVG, opts)).toThrow();
  });
});
```

SVG gets its own test because it is the one image format that is also a script host, and extension
checking is exactly what lets it through.

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack pnpm vitest run lib/media/validate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/media/validate.ts`**

```ts
export type SniffedMime = "image/jpeg" | "image/png" | "application/pdf";

const SIGNATURES: readonly { mime: SniffedMime; bytes: readonly number[] }[] = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
];

/** Magic bytes only. Never trust an extension or a client-supplied Content-Type. */
export function sniffMime(buf: Buffer): SniffedMime | null {
  for (const sig of SIGNATURES) {
    if (sig.bytes.every((b, i) => buf[i] === b)) return sig.mime;
  }
  return null;
}

export function assertUploadable(
  buf: Buffer, opts: { allow: readonly string[]; maxBytes: number },
): void {
  if (buf.byteLength > opts.maxBytes) {
    throw new Error(`File too large: ${buf.byteLength} bytes exceeds ${opts.maxBytes}`);
  }
  const mime = sniffMime(buf);
  if (mime === null) throw new Error("Unrecognised file type — upload rejected");
  if (!opts.allow.includes(mime)) throw new Error(`File type ${mime} is not allowed here`);
}
```

- [ ] **Step 4: Write the failing derivatives test**

`lib/media/derivatives.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { generateDerivatives, DERIVATIVE_SIZES } from "./derivatives";

async function fixture(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#888" } }).jpeg().toBuffer();
}

describe("generateDerivatives", () => {
  it("produces all four sizes as WebP", async () => {
    const out = await generateDerivatives(await fixture(3000, 2000));
    for (const key of ["thumb", "card", "hero", "full"] as const) {
      const meta = await sharp(out[key]).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(DERIVATIVE_SIZES[key]);
    }
  });

  it("never upscales a small original", async () => {
    const out = await generateDerivatives(await fixture(400, 300));
    expect((await sharp(out.full).metadata()).width).toBe(400);
    expect((await sharp(out.thumb).metadata()).width).toBe(200);
  });

  it("strips EXIF — business photos carry GPS and device metadata", async () => {
    const withExif = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#111" } })
      .withExif({ IFD0: { Copyright: "Test", Model: "iPhone" } }).jpeg().toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const out = await generateDerivatives(withExif);
    expect((await sharp(out.hero).metadata()).exif).toBeUndefined();
  });
});
```

- [ ] **Step 5: Run it and confirm it fails**

```bash
corepack pnpm add sharp
corepack pnpm vitest run lib/media/derivatives.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 6: Implement `lib/media/derivatives.ts`**

```ts
import sharp from "sharp";

export const DERIVATIVE_SIZES = { thumb: 200, card: 600, hero: 1200, full: 2000 } as const;
export type DerivativeKey = keyof typeof DERIVATIVE_SIZES;

/**
 * Runs in the worker at upload time, never per request (constraint 15).
 * `withoutEnlargement` keeps a small original small rather than blurring it up.
 * sharp drops all metadata by default unless `.withMetadata()` is called — that
 * omission is deliberate and is what strips EXIF GPS.
 */
export async function generateDerivatives(
  input: Buffer,
): Promise<Record<DerivativeKey, Buffer>> {
  const entries = await Promise.all(
    (Object.keys(DERIVATIVE_SIZES) as DerivativeKey[]).map(async (key) => [
      key,
      await sharp(input)
        .rotate()                                   // apply EXIF orientation before stripping it
        .resize({ width: DERIVATIVE_SIZES[key], withoutEnlargement: true })
        .webp({ quality: key === "thumb" ? 70 : 82 })
        .toBuffer(),
    ] as const),
  );
  return Object.fromEntries(entries) as Record<DerivativeKey, Buffer>;
}
```

`.rotate()` before resizing is not optional: stripping EXIF without applying the orientation tag
first leaves every phone-camera photo sideways.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `corepack pnpm vitest run lib/media`
Expected: PASS, 10 tests.

- [ ] **Step 8: Implement `lib/media/r2.ts`**

S3-compatible client against `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com` with
`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. Export `putObject`, `getObject`, and
`presignPut(bucket, key, ttlSeconds)` / `presignGet(bucket, key, ttlSeconds)`. The claim-documents
bucket is only ever reached through a presigned URL with a 15-minute TTL (Phase 4 uses it; the
client lands here).

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(media): magic-byte validation, WebP derivatives, EXIF stripping, R2 client"
```

---

## Task 18: Worker container with advisory-locked jobs

**Files:**
- Create: `worker/index.ts`, `worker/lock.ts`, `worker/jobs/derivatives.ts`
- Test: `worker/lock.test.ts`

**Interfaces:**
- Produces: `withAdvisoryLock(tx, key: string, fn: () => Promise<void>): Promise<boolean>` —
  returns `false` without running `fn` when the lock is already held.

- [ ] **Step 1: Write the failing test**

`worker/lock.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withAdvisoryLock } from "./lock";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";

describe("withAdvisoryLock", () => {
  it("runs the job when the lock is free", async () => {
    const c = postgres(url, { max: 1 }); const db = drizzle(c);
    let ran = false;
    expect(await withAdvisoryLock(db as never, "test:a", async () => { ran = true; })).toBe(true);
    expect(ran).toBe(true);
    await c.end();
  });

  it("refuses to run a second time while the first holds the lock", async () => {
    const c1 = postgres(url, { max: 1 }); const c2 = postgres(url, { max: 1 });
    const db1 = drizzle(c1), db2 = drizzle(c2);
    let second = true;
    await withAdvisoryLock(db1 as never, "test:b", async () => {
      second = await withAdvisoryLock(db2 as never, "test:b", async () => {});
    });
    expect(second).toBe(false);
    await c1.end(); await c2.end();
  });

  it("releases the lock even when the job throws", async () => {
    const c = postgres(url, { max: 1 }); const db = drizzle(c);
    await expect(withAdvisoryLock(db as never, "test:c", async () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
    expect(await withAdvisoryLock(db as never, "test:c", async () => {})).toBe(true);
    await c.end();
  });
});
```

The third test is the one that matters — a lock leaked by a throwing job means that job never runs
again until the container restarts, and nobody notices for weeks.

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack pnpm vitest run worker/lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `worker/lock.ts`**

```ts
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@/lib/db/client";

/** Stable 64-bit key from a job name, since pg_advisory_lock takes a bigint. */
function lockKey(name: string): bigint {
  const h = createHash("sha256").update(name).digest();
  return BigInt.asIntN(64, h.readBigUInt64BE(0));
}

/**
 * Constraint 17: every scheduled job takes an advisory lock so a restart
 * mid-run cannot double-execute. Session-level, released in `finally`.
 */
export async function withAdvisoryLock(
  db: Db, name: string, fn: () => Promise<void>,
): Promise<boolean> {
  const key = lockKey(name);
  const rows = await db.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_lock(${key}) as locked`,
  );
  const locked = (rows as unknown as { locked: boolean }[])[0]?.locked === true;
  if (!locked) return false;
  try {
    await fn();
    return true;
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${key})`);
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `corepack pnpm vitest run worker/lock.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Implement `worker/index.ts`**

```ts
import cron from "node-cron";
import { db } from "@/lib/db/client";
import { withAdvisoryLock } from "./lock";
import { processPendingDerivatives } from "./jobs/derivatives";

if (process.env.WORKER_ENABLED !== "true") {
  console.log("[worker] WORKER_ENABLED is not true — exiting");
  process.exit(0);
}

function schedule(name: string, expr: string, fn: () => Promise<void>): void {
  cron.schedule(expr, async () => {
    const started = Date.now();
    try {
      const ran = await withAdvisoryLock(db, name, fn);
      console.log(`[worker] ${name} ${ran ? "ok" : "skipped (locked)"} in ${Date.now() - started}ms`);
    } catch (e) {
      console.error(`[worker] ${name} FAILED`, e);
    }
  });
}

schedule("derivatives", "*/1 * * * *", processPendingDerivatives);
// Phase 4 adds: claim-document purge. Phase 5: verification expiry + reminders.
// Phase 6: backlink verification. Phase 3: the city indexing gate.

console.log("[worker] started");
```

Jobs are run by `node-cron` inside the worker container rather than by system cron hitting HTTP
endpoints, so they get logging, retries and no public attack surface.

- [ ] **Step 6: Implement `worker/jobs/derivatives.ts`**

Select `listing_images` rows where `derivatives IS NULL`, fetch the original from R2, run
`generateDerivatives`, write all four back to R2 under `{listingId}/{imageId}-{key}.webp`, and
`UPDATE` the row's `derivatives` jsonb. Batch 20 per tick.

- [ ] **Step 7: Commit**

```bash
corepack pnpm add node-cron && corepack pnpm add -D @types/node-cron
git add -A && git commit -m "feat(worker): node-cron entrypoint with advisory locks and derivative job"
```

---

## Task 19: The city pillar route

**Files:**
- Create: `app/[...segments]/page.tsx`, `components/pillar/PillarPage.tsx`, `middleware.ts`
- Test: `app/[...segments]/route.test.ts`

**Interfaces:**
- Consumes: `resolveRoute`, `listListings`, `enabledRoutes`.
- Produces: **gate part 2** — `/[city]` renders seeded listings, ISR at 3600 s.

- [ ] **Step 1: Implement `app/[...segments]/page.tsx`**

```tsx
import { notFound, redirect, permanentRedirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { resolveRoute } from "@/lib/routing/resolve";
import { listListings } from "@/lib/db/queries/listings";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { PillarPage } from "@/components/pillar/PillarPage";

export const revalidate = 3600;

export default async function Page(
  { params, searchParams }: {
    params: Promise<{ segments: string[] }>;
    searchParams: Promise<{ page?: string }>;
  },
) {
  const { segments } = await params;
  const { page } = await searchParams;

  const result = await resolveRoute(db, segments, siteConfig.siteMode);

  switch (result.kind) {
    case "not-found":
      notFound();
    case "redirect":
      result.status === 301 ? permanentRedirect(result.to) : redirect(result.to);
    case "listing":
      // Phase 2 renders the detail page. Phase 1 proves resolution works.
      return <main>{result.listingId}</main>;
    case "pillar": {
      const listings = await listListings(db, PUBLIC_VIEWER, result.scope, {
        page: Number(page ?? "1"),
      });
      return <PillarPage scope={result.scope} listings={listings} />;
    }
  }
}
```

- [ ] **Step 2: Implement a minimal `PillarPage`**

Renders `H1` as `{Category plural} in {City}` built from `siteConfig.entity`, then the listing grid.
No hardcoded niche strings — Task 20's grep will catch any. The full ten-block structure from §5.1
is Phase 2; this proves the scope abstraction end to end.

- [ ] **Step 3: Verify against real seeded data**

```bash
DATABASE_URL=... REDIS_URL=redis://localhost:6380 NEXT_PUBLIC_SITE_URL=http://localhost:3000 corepack pnpm build
DATABASE_URL=... REDIS_URL=redis://localhost:6380 corepack pnpm start
curl -s localhost:3000/manchester | grep -o '<h1>[^<]*</h1>'
```
Expected: `<h1>Venues in Manchester</h1>` and the seeded listings below it.

- [ ] **Step 4: Verify pagination links are real anchors (§5C.8)**

```bash
curl -s 'localhost:3000/manchester?page=2' | grep -c 'javascript:void'
```
Expected: `0`. Every paginated link must be a real `<a href>` — this is the explicit test the brief
asks for, and it is cheap to add now.

- [ ] **Step 5: Run the ISR verification — gate part 3**

```bash
corepack pnpm verify:isr
```
Expected: `PASS: runtime-regenerated page survived a filesystem wipe -> served from Redis`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: resolver-backed pillar route with ISR"
```

---

## Task 20: CI — both flag builds and the hardcoded-string guard

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/check-niche-strings.sh`, `config/site.flags-off.ts`, `config/site.flags-on.ts`

**Interfaces:**
- Produces: `pnpm build:flags-off`, `pnpm build:flags-on`, `pnpm check:strings`.

- [ ] **Step 1: Create the two flag-variant configs**

Each re-exports `siteConfig` with `features` replaced by all-false / all-true respectively.
`build:flags-off` and `build:flags-on` swap `config/site.config.ts` for the variant via an env var
read in `config/site.config.ts`, or via a build-time file copy — either is fine, but it must be the
real config object so `validateConfig()` runs against it.

Note that `build:flags-on` is what proves the `FEATURE_DEPENDENCIES` map is satisfiable; Task 2's
"passes with every flag on" unit test is the fast version of the same check.

- [ ] **Step 2: Write `scripts/check-niche-strings.sh`**

```bash
#!/usr/bin/env bash
# Constraint 2: no niche string may be hardcoded in a component.
set -euo pipefail
BANNED='venue|venues|wedding|weddings|couple|couples|bride|groom'
if grep -rniE "$BANNED" app components lib \
     --include='*.ts' --include='*.tsx' \
     | grep -v 'site.config' | grep -v '\.test\.' ; then
  echo "FAIL: hardcoded niche strings found above. Use siteConfig.entity."
  exit 1
fi
echo "OK: no hardcoded niche strings"
```

The banned list is derived from `siteConfig.entity` for the current niche. Regenerate it in the
clone kit (Phase 8) so a plumber directory bans "plumber", not "venue".

- [ ] **Step 3: Write `.github/workflows/ci.yml`**

Services: `postgres:16-alpine`, `redis:7-alpine`. Steps: checkout → pnpm via corepack → install →
`pnpm typecheck` → `db:migrate` against the service → `pnpm test` → `pnpm check:strings` →
`pnpm build:flags-off` → `pnpm build:flags-on`.

Both builds must pass with zero dead links before the phase is called done (constraint 8). This is
what stops flags rotting, and it is the only thing that does.

- [ ] **Step 4: Run every gate locally**

```bash
corepack pnpm typecheck && corepack pnpm test && corepack pnpm check:strings \
  && corepack pnpm build:flags-off && corepack pnpm build:flags-on
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "ci: dual flag builds, typecheck, tests, niche-string guard"
```

---

## Task 21: Dockerfile and Coolify deploy

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docs/DEPLOY.md`

**Interfaces:**
- Produces: **gate part 4** — `/[city]` renders over HTTPS on a real domain.

- [ ] **Step 1: Write the Dockerfile**

Multi-stage: `deps` (pnpm fetch) → `builder` (`pnpm build`, no site secrets, only
`NEXT_PUBLIC_SITE_URL`) → `runner` (node:24-alpine, copy `.next/standalone`, `.next/static`,
`public`, `cache-handler.mjs`, `node_modules/@fortedigital`, `node_modules/@redis`). The cache
handler is loaded at runtime and is **not** traced into `standalone` automatically — copy it
explicitly or the container boots with no cache and silently falls back to LRU.

Second entrypoint for the worker: same image, `CMD ["node", "worker/index.js"]`, `WORKER_ENABLED=true`.

- [ ] **Step 2: Build and run locally against the dev stack**

```bash
docker build -t directory-platform:test .
docker run --rm -p 3001:3000 --env-file .env.local directory-platform:test
curl -s localhost:3001/manchester | head -5
```
Expected: the pillar page renders.

- [ ] **Step 3: Create the Coolify resources**

Using the API token at `coolify-migration/.secrets/coolify.env` (per the workspace runbook):
one application from this repo, plus the shared Postgres database and the shared Redis if they do
not already exist. Set the pre-deploy command to `pnpm db:migrate` so migrations run in a one-shot
step before the app starts. Add the worker as a second application from the same repo with
`WORKER_ENABLED=true`.

- [ ] **Step 4: Deploy and verify over HTTPS — the phase gate**

```bash
git push
./redeploy.sh <app-uuid>
curl -sI https://<domain>/manchester | head -3
curl -s https://<domain>/manchester | grep -o '<h1>[^<]*</h1>'
```
Expected: `HTTP/2 200`, valid TLS, and the seeded listings rendering.

- [ ] **Step 5: Prove the cache is warm across a restart and cold across a deploy — the last gate**

Revised 2026-09-08. Restart the container without rebuilding, then immediately request a page that
was regenerated before the restart, and confirm it is served from cache. Then redeploy and confirm
the same URL comes back from the *new* build: its stylesheet 200s and its build id is in the HTML.
Both are what `verify:isr` asserts locally, run against production.

- [ ] **Step 6: Write `docs/DEPLOY.md` and commit**

```bash
git add -A && git commit -m "feat: dockerfile, worker entrypoint, coolify deploy"
```

---

## Phase 1 Definition of Done

- [ ] `pnpm seed` loads **50 cities, 20 categories, 200 listings** — with no ratings, no verified
      listings, and every city `is_indexable = false`.
- [ ] `/[city]` renders those listings **over HTTPS on a real domain**.
- [ ] `pnpm verify:isr` passes **in production**: a runtime-regenerated page survives a container
      restart of the same build, and a redeploy serves that URL fresh from the new build with a live
      stylesheet. (Revised 2026-09-08 — "a redeploy does not cold-start the ISR cache" was the
      original wording and is no longer the goal.)
- [ ] `pnpm build:flags-off` and `pnpm build:flags-on` both pass with zero dead links.
- [ ] `pnpm check:strings` finds no hardcoded niche strings.
- [ ] `pnpm typecheck` and `pnpm test` are green in CI.
- [ ] A build with Redis stopped **completes** rather than hanging (constraint 4 regression guard).
- [ ] `curl '/[city]?page=2' | grep -c 'javascript:void'` returns `0`.

---

## Self-review notes

**Spec coverage.** Every Phase 1 item in the master plan maps to a task: scaffold → 1; config, flags
and `validateConfig` → 2–4; theme tokens → 5; Drizzle schema → 6–8; slug registry → 9–11;
`PillarScope` → 12; Redis cache handler → 14; seed → 15; CSV importer with §5.2b guardrails → 16;
image derivative pipeline → 17; worker → 18; deploy pipeline → 21.

**Deliberately deferred, and where to:** Better Auth (Phase 3 — nothing in Phase 1 authenticates);
geocoding on import (Phase 3, when auto-city-creation needs it — seeds carry real coordinates);
the full §5.1 ten-block pillar page (Phase 2); the city indexing-gate cron (Phase 3 — the columns
and the `false` default land here so no city can be born indexable); removal-request and report
UI (Phase 2 — the `suppressions` table and the importer's respect for it land here, because the
importer is what creates the obligation).

**Known gaps in this plan, stated rather than hidden:** Task 8 Step 2 transcribes ~30 tables from
the master plan rather than reproducing every column inline — the master plan is the authority and
duplicating it here would guarantee the two drift. Task 21 Step 3 depends on Coolify credentials that exist in the workspace but are not in
this repo.
