import postgres from "postgres";

/**
 * The database the e2e suite runs against, resolved once for both the server
 * `playwright.config.ts` starts and any spec that has to clean up after itself.
 *
 * Deliberately NOT `directory_dev`. This suite writes — e2e/location.spec.ts
 * submits a listing through the real form and creates a city with it — and a
 * shared development database is not somewhere to do that. `directory_e2e` is
 * built by `bash scripts/e2e-db.sh` (`corepack pnpm test:e2e:db`) from the same
 * seeds, and can be thrown away at any point.
 */
export const E2E_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_e2e";

/**
 * One short-lived connection, closed whatever happens.
 *
 * Specs use this only to REMOVE what they created. Nothing in the suite may set
 * its own fixtures up this way: a test that writes its preconditions straight
 * into the database proves the page can render rows, not that the app can
 * create them, which is the whole point of the submission test.
 */
export async function withE2eDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
