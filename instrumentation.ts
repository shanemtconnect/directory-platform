import { validateEnv } from "./config/validate";
import { initSentry, serverSentryDsn } from "./lib/observability/sentry";

/**
 * Next calls this once per server process, before the first request.
 *
 * `next.config.ts` only ever runs at build time, so until this existed the
 * runtime half of `validateEnv` had no callers at all and the README's promise
 * that a missing key fails the boot was untrue. A container with no
 * DATABASE_URL used to start, pass its health check, and 500 every page.
 *
 * The Edge runtime loads this file too, where `process.env` holds only what was
 * inlined at build time — validating there would fail on variables that are
 * present and correct, so it is skipped.
 *
 * Async because the node-only work is behind dynamic `import()`. Next awaits
 * `register()`, so the process still refuses to serve a request before the
 * environment has been checked.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    // Works around a Next 16.3.4 defect that emits `Location` twice on a cold
    // ISR redirect. Node-only and dynamically imported for the same reason as
    // the exit below — `node:http` has no business in the edge graph. See
    // lib/boot/location-header.ts for the full diagnosis.
    //
    // Inside this try deliberately: a failing import here is exactly the kind
    // of boot-time failure the catch below exists to turn into a visible exit
    // rather than a silently-hanging or silently-500ing container. Outside
    // the try, that same failure would throw past validateEnv entirely and
    // reintroduce the "keeps running, answers 500 to everything" failure mode
    // this file exists to prevent.
    const { dedupeLocationHeader } = await import("./lib/boot/location-header");
    dedupeLocationHeader();

    validateEnv(process.env, { phase: "runtime" });
  } catch (e) {
    // Throwing is not enough. Next catches whatever `register()` throws, logs
    // "Failed to prepare server" plus an unhandledRejection, and then keeps the
    // process alive: observed on a runner image with DATABASE_URL unset, the
    // container stayed `running`, kept the port open, and answered 500 to every
    // request. To an orchestrator that is a healthy container serving errors,
    // which is precisely the silent failure this hook exists to prevent.
    //
    // Exit instead. A crash-looping container is visible in any deploy UI. The
    // exit lives in lib/boot/exit.ts and is imported dynamically so that
    // `process.exit` never appears in the Edge bundle Turbopack analyses.
    const { fatal } = await import("./lib/boot/exit");
    fatal(e instanceof Error ? e.message : String(e));
  }

  // AFTER the environment check, and outside its try, deliberately. Sentry is
  // the thing that watches the process; it is not a reason to keep a process
  // alive that has already been told to exit, and it must not be able to mask
  // a missing DATABASE_URL by throwing first. `fatal` does not return.
  //
  // Dynamically imported so the SDK is absent from the Edge bundle Turbopack
  // analyses, and never fetched or evaluated without a DSN — which is most
  // clones. `initSentry` is what decides; this closure is only reached when it
  // has already found a DSN.
  await startSentry();
}

/**
 * No `sentry.server.config.ts`. See lib/observability/sentry.ts for why this
 * SDK is wired by hand rather than by its wizard.
 */
async function startSentry(): Promise<void> {
  const dsn = serverSentryDsn();
  if (dsn === undefined) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    initSentry((options) => Sentry.init(options), dsn);
  } catch {
    // An error tracker that cannot load is not a reason to refuse to serve.
  }
}

/**
 * Next calls this for every server-side request error, including the ones
 * thrown inside nested Server Components that never reach `global-error.tsx`
 * because React streamed the page before they failed. Without it, the largest
 * class of server errors on an App Router site is invisible in Sentry.
 *
 * Async and DSN-guarded for the same reason as `startSentry`: on a site with no
 * DSN this must cost nothing and load nothing.
 */
export async function onRequestError(
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
): Promise<void> {
  if (serverSentryDsn() === undefined) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureRequestError(...args);
  } catch {
    // Reporting an error must never be the thing that throws inside the
    // handler for that error.
  }
}
