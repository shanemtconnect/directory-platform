import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@/lib/db/client";

/** Stable 64-bit key from a job name, since pg_advisory_lock takes a bigint. */
export function lockKey(name: string): bigint {
  const h = createHash("sha256").update(name).digest();
  return BigInt.asIntN(64, h.readBigUInt64BE(0));
}

/**
 * Every scheduled job runs inside a transaction holding a TRANSACTION-scoped
 * advisory lock, so a restart mid-run cannot double-execute and two containers
 * cannot race.
 *
 * The scope is the whole point. `pg_try_advisory_lock` is session-scoped and
 * the production handle is a pool of ten connections: the lock is taken on
 * whichever connection the pool hands out, and the `pg_advisory_unlock` in the
 * `finally` runs on whichever connection it hands out next. When those differ
 * the unlock is a no-op against a lock nobody holds, and the real lock leaks
 * until the container restarts — the job then never runs again, and nobody
 * notices for weeks.
 *
 * `pg_try_advisory_xact_lock` cannot leak: Postgres releases it at commit or
 * rollback, including the rollback a throwing job causes. The job is handed
 * the transaction so its own writes are on the connection holding the lock.
 *
 * The trade: the job holds one connection for its whole run. That is the cost
 * of a lock that cannot leak, and these jobs are minutes apart.
 */
export async function withAdvisoryLock(
  db: Db,
  name: string,
  fn: (tx: Db) => Promise<void>,
): Promise<boolean> {
  const key = lockKey(name);
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(${key}) as locked`,
    )) as unknown as { locked: boolean }[];
    if (rows[0]?.locked !== true) return false;

    // The transaction and the pooled handle expose the same query surface;
    // drizzle types them separately, so the job's parameter is widened here
    // rather than at every call site.
    await fn(tx as unknown as Db);
    return true;
  });
}
