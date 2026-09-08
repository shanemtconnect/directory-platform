import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { withAdvisoryLock, lockKey } from "./lock";

const url = process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
const connect = () => {
  const c = postgres(url, { max: 1 });
  return { c, db: drizzle(c) as never };
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
