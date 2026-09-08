import { validateEnv } from "./config/validate";

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
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    validateEnv(process.env, { phase: "runtime" });
  } catch (e) {
    // Throwing is not enough. Next catches whatever `register()` throws, logs
    // "Failed to prepare server" plus an unhandledRejection, and then keeps the
    // process alive: observed on a runner image with DATABASE_URL unset, the
    // container stayed `running`, kept the port open, and answered 500 to every
    // request. To an orchestrator that is a healthy container serving errors,
    // which is precisely the silent failure this hook exists to prevent.
    //
    // Exit instead. A crash-looping container is visible in any deploy UI.
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
