import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { categories, cities, leadPurchases } from "@/lib/db/schema";
import type { TestDb } from "@/test/db";
import { makeCategoryInCity, makeCity, makeVertical } from "@/test/factories";
import { makeBuyer, makeLead } from "@/test/leads";
import { sweepRaceRows } from "@/test/race";
import { creditBalance } from "./credits";
import { buyLead } from "./lead-market";

/**
 * Two buyers press "buy" on one lead at the same moment, on two connections.
 * Committed rows, so both transactions really run at once; cleaned up after.
 */
describe("buyLead concurrency", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
  const client = postgres(url, { max: 4, onnotice: () => {} });
  const database = drizzle(client, { schema });

  afterAll(async () => {
    // Everything hangs off the "Race …" vertical, town and category below.
    try {
      await sweepRaceRows(client);
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("sells to exactly one of two simultaneous buyers and debits only the winner", async () => {
    const setup = await database.transaction(async (raw) => {
      const tx = raw as unknown as TestDb;
      // Committed while the test runs, so every name is unique: a "Leeds" or a
      // "Barn Venues" here would collide with every other file's scaffold.
      const tag = randomUUID().slice(0, 8);
      const verticalId = await makeVertical(tx, `Race Vertical ${tag}`);
      // And as invisible as a committed row can be to files that count
      // globally: no region, an unpublished town, an inactive category.
      const cityId = await makeCity(tx, `Race Town ${tag}`, null);
      const ctx = { cityId, verticalId, primaryCategoryId: await makeCategoryInCity(tx, verticalId, cityId, `Race Things ${tag}`) };
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, cityId));
      await tx.update(categories).set({ isActive: false }).where(eq(categories.id, ctx.primaryCategoryId));
      const a = await makeBuyer(tx, ctx, 5000);
      const b = await makeBuyer(tx, ctx, 5000);
      // A normalised phone no rule-checked test can draw, so this committed
      // row is never another file's "duplicate".
      const leadId = await makeLead(tx, ctx, { phoneNormalised: `race-${tag}` });
      return { ctx, a, b, leadId };
    });

    const attempt = (who: typeof setup.a) =>
      database.transaction(async (raw) => {
        const out = await buyLead(raw as unknown as TestDb, who.viewer, setup.leadId, who.listingId);
        await new Promise((r) => setTimeout(r, 100));
        return out;
      });
    const results = await Promise.all([attempt(setup.a), attempt(setup.b)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["bought", "gone"]);

    const db = database as unknown as TestDb;
    const balances = [await creditBalance(db, setup.a.profileId), await creditBalance(db, setup.b.profileId)].sort();
    expect(balances).toEqual([2500, 5000]);
    expect(await database.select().from(leadPurchases).where(eq(leadPurchases.leadId, setup.leadId))).toHaveLength(1);
  });
});
