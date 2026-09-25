import postgres from "postgres";
import { sweepRaceRows } from "./race";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgres://directory:directory@localhost:5433/directory_test";

/** Refused connection or missing database: the DB-backed tests will say so themselves. */
function unreachable(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "ECONNREFUSED" || code === "3D000" || code === "ENOTFOUND";
}

async function sweep(): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sweepRaceRows(client);
  } catch (e) {
    if (!unreachable(e)) throw e;
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Clears anything a killed `*.race.test.ts` run committed to `directory_test`
 * (see test/race.ts) before either suite starts, and again after the race
 * suite, so one crashed run can never skew the next run's counts or slugs.
 */
export default async function setup(): Promise<() => Promise<void>> {
  await sweep();
  return sweep;
}
