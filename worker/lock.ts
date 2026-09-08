import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@/lib/db/client";

/** Stable 64-bit key from a job name, since pg_advisory_lock takes a bigint. */
export function lockKey(name: string): bigint {
  const h = createHash("sha256").update(name).digest();
  return BigInt.asIntN(64, h.readBigUInt64BE(0));
}

/**
 * Every scheduled job takes an advisory lock, so a restart mid-run cannot
 * double-execute and two containers cannot race.
 *
 * Released in `finally`: a lock leaked by a throwing job means that job never
 * runs again until the container restarts, and nobody notices for weeks.
 */
export async function withAdvisoryLock(
  db: Db,
  name: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const key = lockKey(name);
  const rows = (await db.execute(
    sql`select pg_try_advisory_lock(${key}) as locked`,
  )) as unknown as { locked: boolean }[];
  if (rows[0]?.locked !== true) return false;
  try {
    await fn();
    return true;
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${key})`);
  }
}
