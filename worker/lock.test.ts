import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { withAdvisoryLock, lockKey } from "./lock";

const url = process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
const connect = () => {
  const c = postgres(url, { max: 1 });
  return { c, db: drizzle(c, { schema }) as Db };
};

describe("withAdvisoryLock", () => {
  it("runs the job when the lock is free", async () => {
    const { c, db } = connect();
    let ran = false;
    expect(await withAdvisoryLock(db, "test:a", async () => { ran = true; })).toBe(true);
    expect(ran).toBe(true);
    await c.end();
  });

  it("refuses a second run while the first holds the lock", async () => {
    const a = connect(), b = connect();
    let second = true;
    await withAdvisoryLock(a.db, "test:b", async () => {
      second = await withAdvisoryLock(b.db, "test:b", async () => {});
    });
    expect(second).toBe(false);
    await a.c.end(); await b.c.end();
  });

  it("releases the lock even when the job throws", async () => {
    const { c, db } = connect();
    await expect(withAdvisoryLock(db, "test:c", async () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
    // If the lock leaked, this second call would return false forever.
    expect(await withAdvisoryLock(db, "test:c", async () => {})).toBe(true);
    await c.end();
  });

  /**
   * The production handle is a pool. A SESSION-level advisory lock is held by
   * one connection, so two concurrent runs get two different connections and
   * both acquire — and the unlock afterwards lands on whichever connection the
   * pool hands out next, which may not be the one holding the lock, leaking it
   * until the container restarts.
   */
  it("never runs the same job twice at once on one pooled handle", async () => {
    const c = postgres(url, { max: 4 });
    const db = drizzle(c, { schema }) as Db;
    let runs = 0;
    const job = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 150));
    };

    const results = await Promise.all([
      withAdvisoryLock(db, "test:pooled", job),
      withAdvisoryLock(db, "test:pooled", job),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(runs).toBe(1);
    await c.end();
  });

  it("frees the lock for the next run on the same pooled handle", async () => {
    const c = postgres(url, { max: 4 });
    const db = drizzle(c, { schema }) as Db;
    for (let i = 0; i < 3; i++) {
      expect(await withAdvisoryLock(db, "test:pooled-serial", async () => {})).toBe(true);
    }
    await c.end();
  });

  it("hands the job the transaction that holds the lock", async () => {
    const { c, db } = connect();
    let sawLock: boolean | undefined;
    await withAdvisoryLock(db, "test:handle", async (tx) => {
      const rows = (await tx.execute(
        sql`select pg_try_advisory_xact_lock(${lockKey("test:handle")}) as locked`,
      )) as unknown as { locked: boolean }[];
      // Re-taking our own transaction-scoped lock succeeds; the point is that
      // the job runs on the handle that holds it, not on a fresh connection.
      sawLock = rows[0]?.locked;
    });
    expect(sawLock).toBe(true);
    await c.end();
  });

  it("gives different jobs different keys and the same job a stable one", () => {
    expect(lockKey("derivatives")).toBe(lockKey("derivatives"));
    expect(lockKey("derivatives")).not.toBe(lockKey("purge-claim-docs"));
  });

  it("keeps the key inside signed 64-bit range for pg", () => {
    for (const n of ["a", "derivatives", "verification-expiry", "backlink-check"]) {
      const k = lockKey(n);
      expect(k).toBeLessThanOrEqual(2n ** 63n - 1n);
      expect(k).toBeGreaterThanOrEqual(-(2n ** 63n));
    }
  });
});
