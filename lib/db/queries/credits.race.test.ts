import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { profiles, user } from "@/lib/db/schema";
import type { TestDb } from "@/test/db";
import { RACE_USER_PREFIX, sweepRaceRows } from "@/test/race";
import type { Viewer } from "@/lib/db/viewer";
import { InsufficientCredit, creditBalance, debitForPurchase, postLedger } from "./credits";

const SYSTEM: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };

/**
 * Two transactions in flight at once against COMMITTED rows: the only way the
 * advisory lock is tested at all. `withTestDb` gives one throwaway
 * transaction, so this opens its own connections and cleans up after itself.
 */
describe("debitForPurchase concurrency", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
  const client = postgres(url, { max: 4, onnotice: () => {} });
  const database = drizzle(client, { schema });
  const userId = `${RACE_USER_PREFIX}${randomUUID()}`;

  afterAll(async () => {
    // Finds the user by its u_race_ prefix; deleting it cascades to the
    // profile and its ledger rows.
    try {
      await sweepRaceRows(client);
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("lets exactly one of two simultaneous debits through when the balance covers only one", async () => {
    await database.insert(user).values({ id: userId, name: "Race", email: `${userId}@example.com` });
    const [p] = await database.insert(profiles).values({ userId }).returning({ id: profiles.id });
    const profileId = p!.id;
    await postLedger(database as unknown as TestDb, SYSTEM, { userId: profileId, deltaCents: 5000, kind: "topup" });

    const attempt = () =>
      database.transaction(async (tx) => {
        const out = await debitForPurchase(tx as unknown as TestDb, SYSTEM, { userId: profileId, cents: 4000, leadId: randomUUID() });
        // Hold the lock a moment so the two genuinely overlap.
        await new Promise((r) => setTimeout(r, 100));
        return out;
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCredit);
    expect(await creditBalance(database as unknown as TestDb, profileId)).toBe(1000);
  });
});
