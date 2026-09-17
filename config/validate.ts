import type { FeatureFlag, FeatureMap } from "./types";
import { isSupportedCountry, COUNTRY_PROFILES, SUPPORTED_COUNTRIES } from "../lib/geo/countries";
import { siteConfig } from "./site.config";

const isBlank = (v: string | undefined): boolean => v === undefined || v.trim() === "";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Some flags are meaningless without others. Awards are computed from review
 * volume; quote broadcast selects from a shortlist. An unmet dependency fails
 * the build rather than warning — a half-wired feature is worse than an absent one.
 */
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

/**
 * Needed to produce the build. Everything else is injected at boot, because the
 * image is built once in CI with no site secrets and then run per site with its
 * own .env. Requiring DATABASE_URL here would make the image unbuildable.
 */
export const BUILD_ENV = ["NEXT_PUBLIC_SITE_URL"] as const;

/**
 * Also build-time, but the site still works without them.
 *
 * `NEXT_PUBLIC_` values are inlined into the client bundle by `next build`, so
 * one injected at boot is silently ignored — listing these as runtime keys was
 * a lie that hid a real deploy trap. They are optional because their features
 * degrade rather than break: without a MapTiler key the map is not rendered and
 * the listings are still there (global constraint 13), and without a media URL
 * images resolve against the site's own origin.
 */
export const BUILD_ENV_OPTIONAL = ["NEXT_PUBLIC_MAPTILER_KEY", "NEXT_PUBLIC_MEDIA_URL"] as const;

/**
 * Monitoring. All four optional, none of them warned about, and the complete
 * list of what this platform reads for observability.
 *
 *   NEXT_PUBLIC_SENTRY_DSN       — browser error reporting. BUILD-time: it is
 *                                  inlined into the client bundle, so setting
 *                                  it at boot does nothing (instrumentation-client.ts).
 *   SENTRY_DSN                   — server error reporting (instrumentation.ts).
 *                                  Runtime. Falls back to the public one, so a
 *                                  site with a single DSN in a single variable
 *                                  still reports server errors.
 *   NEXT_PUBLIC_PLAUSIBLE_DOMAIN — the analytics script's data-domain. BUILD-time,
 *                                  same reason. Unset means no script at all,
 *                                  which is also how a clone opts out.
 *   UPTIME_PUSH_URL              — an Uptime Kuma push monitor the worker GETs
 *                                  on each five-minute heartbeat. Runtime. The
 *                                  web container is watched by /api/health
 *                                  instead, a pull check needing no variable.
 *
 * Deliberately NOT in BUILD_ENV_OPTIONAL above, which is the list `validateEnv`
 * prints a build warning for. That warning exists because a missing MapTiler
 * key silently disables a feature somebody paid for and expects to see. Nobody
 * expects to see an error tracker, most clones will never buy one, and a
 * warning printed on every build of every site is a warning nobody reads by the
 * time it matters.
 *
 * Nothing here is ever enforced. A boot that failed over a missing monitoring
 * URL would be precisely the outage the monitoring was bought to detect.
 */
export const OBSERVABILITY_ENV_OPTIONAL = [
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_DSN",
  "NEXT_PUBLIC_PLAUSIBLE_DOMAIN",
  "UPTIME_PUSH_URL",
] as const;

/**
 * Required to boot. Deliberately short: only the variables whose features are
 * actually wired today. Refusing to start over a key nothing reads yet is an
 * outage the code chose to have.
 */
export const RUNTIME_ENV = [
  "NEXT_PUBLIC_SITE_URL",
  "DATABASE_URL",
  "REDIS_URL",
  // Better Auth is wired (lib/auth/*, /login, /account, /admin). Without a
  // secret every session cookie is signed with a key the next boot does not
  // have, and without the URL the callbacks point at the wrong origin. A site
  // that starts in either state serves a quietly broken login, which is worse
  // than one that refuses to start.
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
] as const;

/**
 * Required ONCE BILLING IS TURNED ON, and not before.
 *
 * Billing is opt-in per site: a directory can run for months on free listings
 * alone, and a boot that fails for want of a PayPal key it never uses is an
 * outage the code chose to have. So `PAYPAL_CLIENT_ID` is the switch — when it
 * is set, the site is taking money, and the rest of this group has to be there
 * too:
 *
 *   PAYPAL_CLIENT_SECRET — no secret, no API call; every checkout 500s.
 *   PAYPAL_WEBHOOK_ID    — the nastiest of the three, because nothing looks
 *                          broken. Unset, `verifyWebhookSignature` rejects
 *                          every delivery (it fails closed, as it must), so
 *                          activations and renewals silently never land and a
 *                          paying customer's listing lapses on its own.
 *   PAYPAL_PLAN_*        — one id per billable tier and interval, derived from
 *                          config/site.config.ts by scripts/paypal-setup.ts.
 *                          A missing one means that plan's checkout can only
 *                          say "not available", which is a dead pricing page.
 *
 * PAYPAL_ENV is deliberately NOT required: it defaults to the sandbox, and the
 * failure mode of forgetting it is taking test money rather than real money.
 */
export const BILLING_ENV_SWITCH = "PAYPAL_CLIENT_ID";

const BILLING_INTERVALS = ["monthly", "annual"] as const;

/**
 * One plan id per billable tier and interval, derived from the tier prices.
 *
 * Derived HERE rather than imported from `lib/billing/plans.ts`, which is
 * where the same list lives for the application. `next.config.ts` imports this
 * file and Next compiles it with relative module resolution only, so anything
 * this file reaches for must avoid the `@/` alias — and `lib/billing/plans.ts`
 * is full of it. A build that cannot load next.config is a build that does not
 * happen, which is a worse failure than one duplicated `flatMap`.
 *
 * The two lists are asserted equal in `lib/billing/plans.test.ts`, so they
 * cannot drift apart in silence.
 */
export const PLAN_ENV_VARS: readonly string[] = Object.entries(siteConfig.tiers)
  .filter(([, tier]) => tier.priceAnnual > 0 || tier.priceMonthly > 0)
  .flatMap(([name]) =>
    BILLING_INTERVALS.map((interval) =>
      `PAYPAL_PLAN_${name.toUpperCase()}_${interval.toUpperCase()}`,
    ),
  );

export const BILLING_ENV: readonly string[] = [
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  ...PLAN_ENV_VARS,
];

/**
 * Not enforced yet. Each group moves into RUNTIME_ENV when the phase that reads
 * it lands, so the list stays a checklist rather than folklore:
 *
 *   R2_*            — Phase 2, media upload and claim-document storage.
 *   RESEND_API_KEY / EMAIL_FROM / ADMIN_NOTIFICATION_EMAIL
 *                   — transactional email. Wired, but deliberately staying
 *                     here: lib/email/sender.ts logs and sends nothing when
 *                     they are unset, so a preview environment without mail
 *                     credentials still boots and still takes enquiries.
 *
 * PAYPAL_* has moved out of this list into BILLING_ENV above: it is enforced
 * now, but conditionally rather than always.
 *
 * Deliberately absent: TURNSTILE_* and MAPTILER_KEY. Both stay optional after
 * their phases ship — the form falls back to server-side rate limiting and the
 * map is never required to see the listings — so neither should ever fail a boot.
 *
 * Also optional, and also never enforced:
 *
 *   INTERNAL_REVALIDATE_SECRET — shared by the web and worker containers. The
 *                                worker POSTs the ISR paths a tier change or
 *                                backlink boost left stale to
 *                                /api/internal/revalidate with it as a bearer
 *                                token (lib/revalidate/client.ts). Unset, the
 *                                route 404s and the worker logs once and
 *                                skips: pages then catch up when their ISR
 *                                window turns over, which is what happened
 *                                before the route existed. Set the SAME value
 *                                on both services or nothing is revalidated.
 */
export const RUNTIME_ENV_PHASE5 = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_MEDIA",
  "R2_BUCKET_CLAIM_DOCS",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "ADMIN_NOTIFICATION_EMAIL",
] as const;

/**
 * Nothing when billing is off; the whole group when it is on.
 *
 * Returned rather than thrown so `validateEnv` can report it in the same
 * message as everything else that is missing.
 */
export function missingBillingEnv(env: Record<string, string | undefined>): string[] {
  if (isBlank(env[BILLING_ENV_SWITCH])) return [];
  return BILLING_ENV.filter((k) => isBlank(env[k]));
}

export function validateEnv(
  env: Record<string, string | undefined>,
  opts: { phase: "build" | "runtime" },
): void {
  const required: readonly string[] = opts.phase === "build" ? BUILD_ENV : RUNTIME_ENV;
  const missing = required.filter((k) => isBlank(env[k]));
  // Conditional, and only at runtime: a build has no site secrets at all.
  if (opts.phase !== "build") missing.push(...missingBillingEnv(env));
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables (${opts.phase}):\n  - ${missing.join("\n  - ")}\n` +
        `See .env.example. A site that boots without these is worse than one that refuses to.`,
    );
  }

  if (opts.phase !== "build") return;
  const absent = BUILD_ENV_OPTIONAL.filter((k) => isBlank(env[k]));
  if (absent.length > 0) {
    console.warn(
      `[config] Building without:\n  - ${absent.join("\n  - ")}\n` +
        `These are inlined at build time, so setting them at boot will NOT help — ` +
        `rebuild the image with them as build args. The site works without them; ` +
        `the map and the media CDN are what degrade.`,
    );
  }
}


/**
 * These directories run in several markets. A clone that sets an unsupported
 * country, or pairs a country with a currency that makes no sense for it,
 * fails the build rather than shipping a US site quoting prices in pounds.
 */
export function validateCountry(config: {
  country: string;
  currency: string;
  locale: string;
}): void {
  if (!isSupportedCountry(config.country)) {
    throw new ConfigError(
      `Unsupported country "${config.country}" in config/site.config.ts. ` +
        `Supported: ${SUPPORTED_COUNTRIES.join(", ")}. Add a profile in lib/geo/countries.ts first.`,
    );
  }
  const profile = COUNTRY_PROFILES[config.country];
  const problems: string[] = [];
  if (config.currency !== profile.defaultCurrency) {
    problems.push(
      `currency "${config.currency}" is unusual for ${profile.name} (expected ${profile.defaultCurrency})`,
    );
  }
  if (!config.locale.endsWith(config.country)) {
    problems.push(`locale "${config.locale}" does not match country "${config.country}"`);
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `Country configuration looks wrong:\n  - ${problems.join("\n  - ")}\n` +
        `If this is deliberate, change the check in config/validate.ts rather than the config.`,
    );
  }
}

/**
 * A clone starts life full of placeholders, which is fine right up until it is
 * serving the public. `legalEntity: "TBC"` reaches the footer, the terms page
 * and the Organization JSON-LD; an @example.com support address means a
 * customer's email goes nowhere. Neither is visible in a smoke test, so the
 * build is where it has to be caught.
 *
 * Staging is exempt: it exists to be run before the real details exist.
 */
const PLACEHOLDER_EMAIL_DOMAINS = ["example.co.uk", "example.com"] as const;

/**
 * `next build` sets NODE_ENV=production for every build, including
 * `pnpm build:flags-off` and the build Playwright runs, so NODE_ENV alone
 * cannot tell a release from a verification build. What can: the site URL.
 * Nothing served on localhost or on an RFC 2606 / RFC 6761 reserved name is
 * reachable by the public, so nothing there can leak a placeholder.
 */
const RESERVED_SUFFIXES = [".example", ".test", ".local", ".localhost", ".invalid"] as const;

function isUnreachableOrigin(siteUrl: string | undefined): boolean {
  if (siteUrl === undefined || siteUrl.trim() === "") return false;
  let host: string;
  try {
    host = new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // "[::1]", not "::1": WHATWG URL keeps the brackets on an IPv6 hostname, so the
  // unbracketed form is a comparison that can never be true.
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
  return RESERVED_SUFFIXES.some((s) => host.endsWith(s));
}

export function validateProductionConfig(
  config: { legalEntity: string; supportEmail: string; dataController: string },
  env: Record<string, string | undefined>,
): void {
  if (env.NODE_ENV !== "production" || env.SITE_ENV === "staging") return;
  if (isUnreachableOrigin(env.NEXT_PUBLIC_SITE_URL)) return;

  const problems: string[] = [];
  if (config.legalEntity.trim() === "" || config.legalEntity.trim().toUpperCase() === "TBC") {
    problems.push(`legalEntity is still "${config.legalEntity}"`);
  }
  // Defaults to legalEntity in config/site.config.ts (`legal.dataController`)
  // and reaches the privacy policy as who is responsible for visitor data —
  // same placeholder, same failure.
  if (
    config.dataController.trim() === "" ||
    config.dataController.trim().toUpperCase() === "TBC"
  ) {
    problems.push(`dataController is still "${config.dataController}"`);
  }
  const email = config.supportEmail.trim().toLowerCase();
  if (PLACEHOLDER_EMAIL_DOMAINS.some((d) => email.endsWith(`@${d}`) || email.endsWith(`.${d}`))) {
    problems.push(`supportEmail "${config.supportEmail}" is a placeholder address`);
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `config/site.config.ts is not ready for production:\n  - ${problems.join("\n  - ")}\n` +
        `Fill these in, or set SITE_ENV=staging if this build is not going to the public.`,
    );
  }
}
