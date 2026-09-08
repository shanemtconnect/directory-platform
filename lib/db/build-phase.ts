/**
 * Is this `next build` prerendering a page with no database to prerender from?
 *
 * `/`, `/cities` and `/categories` are ISR pages (`revalidate = 3600`) that read
 * Postgres, so `next build` used to need a reachable database purely to fill a
 * cache entry that expires an hour later. That put a live DATABASE_URL into the
 * Docker builder stage, where it is neither wanted nor available in CI.
 *
 * The three pages ask this first. When it is true they prerender the shell they
 * already render for an empty database — the "no locations are listed yet"
 * state — and ISR regenerates the real page on the first request after boot,
 * where a database is guaranteed to exist because `instrumentation.ts` will not
 * let the server start without one.
 *
 * Two things this deliberately is NOT:
 *
 *  - a `force-static` export, which would freeze the page at build output for
 *    ever rather than letting ISR replace it;
 *  - a try/catch around the query, which would also swallow a real outage at
 *    runtime and quietly serve an empty homepage instead of a 500.
 *
 * It is scoped to exactly one moment — the production build, with no
 * DATABASE_URL — and is false everywhere else, including a normal build with a
 * database, where all three pages prerender with real data as before.
 */
export function prerenderingWithoutDatabase(): boolean {
  return (
    process.env["NEXT_PHASE"] === "phase-production-build" &&
    (process.env["DATABASE_URL"] ?? "").trim() === ""
  );
}
