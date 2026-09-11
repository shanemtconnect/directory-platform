import * as Sentry from "@sentry/nextjs";
import { clientSentryDsn, initSentry } from "@/lib/observability/sentry";

/**
 * The browser half of the boot contract. Next loads this file once, before the
 * app hydrates — the client-side counterpart to `instrumentation.ts`, and the
 * replacement for the `sentry.client.config.ts` the SDK's wizard would write.
 *
 * The import is static, unlike the server's. A dynamic `import()` here would
 * become a second chunk fetched at runtime, i.e. a network round trip before
 * any error can be reported — and the errors worth catching happen early. The
 * cost is that the SDK ships in the bundle whether or not a DSN is set; the
 * cost of the alternative is missing the first seconds of every session.
 *
 * `initSentry` still does the guarding: with no `NEXT_PUBLIC_SENTRY_DSN` the
 * SDK is never initialised, installs no handlers, patches no `fetch`, and
 * prints nothing. `NEXT_PUBLIC_` values are inlined by `next build`, so a DSN
 * added at boot will not appear here — it is a rebuild, like every other
 * `NEXT_PUBLIC_` variable (see config/validate.ts).
 */
initSentry((options) => Sentry.init(options), clientSentryDsn());

/**
 * Client-side navigation timing. Next looks this export up by name; without it
 * every route change after the first is missing from a trace.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
