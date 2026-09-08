import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgres://directory:directory@localhost:5433/directory_test";

class RollbackSignal extends Error {}

/**
 * The production handle type, re-exported under the name the test helpers use.
 *
 * These were two structurally different types, which is why every call site
 * wrote `db as never`. One alias means the real `db` and a test transaction are
 * interchangeable and the casts go away.
 */
export type TestDb = Db;

/**
 * Runs `fn` inside a transaction that is always rolled back, so integration
 * tests share one migrated database without contaminating each other and
 * without a truncate step between them.
 */
export async function withTestDb<T>(fn: (tx: TestDb) => Promise<T>): Promise<T> {
  const client = postgres(url, { max: 1 });
  const database = drizzle(client, { schema });
  try {
    let out: T | undefined;
    await database
      .transaction(async (tx) => {
        out = await fn(tx as unknown as TestDb);
        throw new RollbackSignal();
      })
      .catch((e: unknown) => {
        if (!(e instanceof RollbackSignal)) throw e;
      });
    return out as T;
  } finally {
    await client.end({ timeout: 5 });
  }
}
