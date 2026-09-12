/**
 * Sentry, wired by hand rather than by `@sentry/nextjs`'s wizard.
 *
 * The wizard writes `sentry.server.config.ts`, `sentry.edge.config.ts` and a
 * `withSentryConfig()` wrapper around `next.config.ts`. We take none of it:
 *
 *  - `withSentryConfig` exists mainly to upload source maps, which needs an
 *    auth token and an org/project at BUILD time. This image is built once in
 *    CI with no per-site secrets and then run for many sites, so there is no
 *    build-time Sentry account to upload to. (`@sentry/cli`'s 16 MB binary is
 *    skipped for the same reason — see pnpm-workspace.yaml.)
 *  - `instrumentation.ts` here already carries the boot contract that exits the
 *    process on missing environment. Adding a second file that Next loads at a
 *    different moment splits that contract in two.
 *
 * What is lost: stack traces in Sentry point at minified output. What is kept:
 * errors, with their environment, arriving with no DSN in the build and no
 * warning in the log when there isn't one.
 *
 * No import of `@sentry/nextjs` in this file. It is imported by the two
 * runtimes that call `initSentry`, so the options can be unit-tested without
 * pulling the SDK — and, more to the point, without a `"use client"` boundary
 * deciding which of the SDK's three entry points this module means.
 */

/** The fields we set. Structurally a subset of Sentry's own options type. */
export interface SentryInitOptions {
  dsn: string;
  tracesSampleRate: number;
  sendDefaultPii: boolean;
  /** Omitted where it cannot be known — see `sentryOptions`. */
  environment?: string;
}

/**
 * One request in ten carries a trace. Tracing is billed per span and a
 * directory's traffic is mostly cached page views that look identical; a tenth
 * is enough to see a slow query and cheap enough to leave on.
 */
export const TRACES_SAMPLE_RATE = 0.1;

const clean = (v: string | undefined): string | undefined => {
  const trimmed = v?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * `SENTRY_DSN` first, then the public one.
 *
 * The fallback is deliberate: a site that sets only `NEXT_PUBLIC_SENTRY_DSN`
 * would otherwise report browser errors and silently drop every server error,
 * and server errors are the half that takes a page down. A Sentry DSN is not a
 * secret — it is embedded in every browser bundle by design — so there is
 * nothing leaked by the server using the public one.
 */
export function serverSentryDsn(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return clean(env.SENTRY_DSN) ?? clean(env.NEXT_PUBLIC_SENTRY_DSN);
}

/**
 * Only the `NEXT_PUBLIC_` one, and never the server fallback above:
 * `SENTRY_DSN` is not inlined into the client bundle, so reading it here would
 * compile to `undefined` in the browser while looking, in the source, as though
 * the client were configured.
 *
 * The parameter is the DSN itself rather than an environment record, which
 * looks like an inconsistency and is not. `next build` inlines a
 * `NEXT_PUBLIC_*` value by substituting the literal member expression
 * `process.env.NEXT_PUBLIC_SENTRY_DSN` in the source text. Reaching it through
 * a variable — `env.NEXT_PUBLIC_SENTRY_DSN`, where `env` happens to be
 * `process.env` — is not that expression, so nothing is substituted and the
 * browser reads a property of an object that does not have it. The whole
 * client half of this integration would be dead, silently, and only in a
 * production build. The default argument below is the one place the literal
 * has to appear.
 */
export function clientSentryDsn(
  dsn: string | undefined = process.env.NEXT_PUBLIC_SENTRY_DSN,
): string | undefined {
  return clean(dsn);
}

/**
 * `sendDefaultPii: false` is the whole reason this is a function rather than an
 * inline object at two call sites. With it on, Sentry attaches IP addresses,
 * cookies and request bodies to every event — and the bodies on this site are
 * enquiry forms carrying a member of the public's name, email address and
 * message. A third-party error tracker is not a lawful place to put those, and
 * the privacy policy does not say they go there.
 *
 * `environment` mirrors `lib/site-env.ts` when it can: anything that is not the
 * literal "production" is staging. It is OMITTED rather than guessed when
 * `SITE_ENV` is not readable, which in practice means the browser —
 * `SITE_ENV` has no `NEXT_PUBLIC_` prefix, so it is not inlined into the client
 * bundle and cannot be. Tagging every browser event "staging" because the value
 * was missing would be worse than not tagging it: an operator would filter
 * their production dashboard on `environment:production` and see none of their
 * real users' errors. Sentry's own default takes over instead.
 *
 * Read from the passed env rather than by calling `siteEnv()` so this module
 * stays importable from the client bundle without dragging
 * `config/site.config.ts` in behind it.
 */
export function sentryOptions(
  dsn: string,
  env: Record<string, string | undefined> = process.env,
): SentryInitOptions {
  const siteEnv = clean(env.SITE_ENV);
  return {
    dsn,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    ...(siteEnv === undefined
      ? {}
      : { environment: siteEnv === "production" ? "production" : "staging" }),
  };
}

/**
 * Initialise, if there is anything to initialise.
 *
 * Returns whether it ran, so a caller can log. Calling `Sentry.init` with an
 * undefined DSN is not harmless: the SDK installs its global handlers, patches
 * fetch and http, and prints a warning on every boot of every site that has no
 * Sentry account — which is most of them, and which is exactly the noise that
 * teaches people to ignore boot logs.
 *
 * A throw from inside `init` is swallowed. An error tracker that cannot start
 * must never be the thing that stops the server booting; the one case where
 * that matters is a malformed DSN pasted into an environment variable, and
 * crash-looping the site over it would be a self-inflicted outage.
 */
export function initSentry(
  init: (options: SentryInitOptions) => void,
  dsn: string | undefined = serverSentryDsn(),
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (dsn === undefined) return false;
  try {
    init(sentryOptions(dsn, env));
    return true;
  } catch {
    return false;
  }
}
