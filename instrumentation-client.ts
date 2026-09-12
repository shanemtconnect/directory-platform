import { clientSentryDsn, initSentry } from "@/lib/observability/sentry";

/**
 * The browser half of the boot contract. Next loads this file once, before the
 * app hydrates — the client-side counterpart to `instrumentation.ts`, and the
 * replacement for the `sentry.client.config.ts` the SDK's wizard would write.
 *
 * The SDK is imported DYNAMICALLY, and only when a DSN was inlined at build
 * time. Statically, it lands in `rootMainFiles` — the chunks every page of the
 * site loads before anything renders — and measured on this app that is about
 * 190 KB of JavaScript downloaded and parsed by every visitor of every clone,
 * including the clones with no Sentry account, which is most of them. A
 * platform meant to be cloned cannot make its default configuration pay for a
 * feature its default configuration does not use.
 *
 * What that costs: errors thrown in the few milliseconds between this module
 * running and the chunk arriving are not captured. Worth it, and only paid by
 * sites that opted in.
 *
 * `NEXT_PUBLIC_` values are inlined by `next build`, so the DSN check below is
 * a comparison against a literal — a site adding Sentry later rebuilds, exactly
 * as it would to change `SITE_ENV`. With no DSN the condition is statically
 * false, and the SDK is never fetched or evaluated without a DSN.
 */
type RouterTransitionStart = (href: string, navigationType: string) => void;

let captureRouterTransitionStart: RouterTransitionStart | undefined;

const dsn = clientSentryDsn();
if (dsn !== undefined) {
  void import("@sentry/nextjs")
    .then((Sentry) => {
      initSentry((options) => Sentry.init(options), dsn);
      captureRouterTransitionStart = Sentry.captureRouterTransitionStart;
    })
    .catch(() => {
      // An error tracker that cannot load must not blank the page it was meant
      // to report on.
    });
}

/**
 * Client-side navigation timing. Next looks this export up by name at load, so
 * it cannot be conditional — it forwards to the SDK once the chunk above has
 * arrived, and does nothing before that or when no DSN is configured. Without
 * it every route change after the first is missing from a trace.
 */
export const onRouterTransitionStart: RouterTransitionStart = (href, navigationType) => {
  captureRouterTransitionStart?.(href, navigationType);
};
