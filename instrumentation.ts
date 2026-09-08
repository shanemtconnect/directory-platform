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
  validateEnv(process.env, { phase: "runtime" });
}
