import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { TestDb } from "@/test/db";
import { allocateSlug } from "./slugs";
import { slugs } from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * The one case a rolled-back single-connection test cannot reach.
 *
 * Two imports of the same business name landing at once used to pass the
 * "is it taken?" check together, and the loser's INSERT raised 23505 — which
 * in Postgres poisons the whole surrounding transaction, so the import aborted
 * rather than taking the next candidate. These two run on their own committed
 * connections; the scope is a fresh uuid so nothing else in the suite sees them.
 */
describe("allocateSlug under concurrency", () => {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgres://directory:directory@localhost:5433/directory_test";

  it("gives two simultaneous callers two different slugs", async () => {
    const scope = randomUUID();
    const clients = [postgres(url, { max: 1 }), postgres(url, { max: 1 })];
    const dbs = clients.map((c) => drizzle(c, { schema }) as unknown as TestDb);
    try {
      const allocated = await Promise.all(
        dbs.map((tx) =>
          allocateSlug(tx, {
            parentScope: scope, desired: "The Barn", kind: "listing", entityId: randomUUID(),
          }),
        ),
      );
      expect(new Set(allocated).size).toBe(2);
      expect(allocated).toContain("the-barn");
      expect(allocated).toContain("the-barn-2");
    } finally {
      // These rows are committed, not rolled back, so clean up after them.
      await dbs[0]?.delete(slugs).where(eq(slugs.parentScope, scope));
      await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
    }
  });
});
