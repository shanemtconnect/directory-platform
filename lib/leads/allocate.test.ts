import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { creditLedger, jobQueue, leadPurchases, leadStandingOrders, leads } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeCategory, makeCity, makeScaffold, type ListingCtx } from "@/test/factories";
import { makeBuyer, makeLead, makeStandingOrder } from "@/test/leads";
import { creditBalance } from "@/lib/db/queries/credits";
import { NOTIFY_LEAD_TOPUP, NOTIFY_LEAD_WON } from "@/lib/email/notify";
import { allocateLead, retryAllocation } from "./allocate";

const T = (s: string) => new Date(`2026-09-${s}T12:00:00Z`);

async function jobs(tx: TestDb, kind: string, key: string, id: string): Promise<number> {
  const rows = await tx.select({ id: jobQueue.id }).from(jobQueue)
    .where(and(eq(jobQueue.kind, kind), sql`${jobQueue.payload}->>${key} = ${id}`));
  return rows.length;
}

async function order(tx: TestDb, id: string) {
  const [row] = await tx.select().from(leadStandingOrders).where(eq(leadStandingOrders.id, id));
  return row!;
}

async function scaffold(tx: TestDb): Promise<ListingCtx> {
  return makeScaffold(tx);
}

describe("allocateLead", () => {
  it("sells to the highest price; the winner is debited its own price, the lead is sold and the won email queued", async () => {
    await withTestDb(async (tx) => {
      const ctx = await scaffold(tx);
      const low = await makeBuyer(tx, ctx, 10_000);
      const high = await makeBuyer(tx, ctx, 10_000);
      const lowOrder = await makeStandingOrder(tx, low, { priceCents: 2500 });
      const highOrder = await makeStandingOrder(tx, high, { priceCents: 4000 });
      const leadId = await makeLead(tx, ctx);

      const out = await allocateLead(tx, PUBLIC_VIEWER, leadId);
      expect(out).toMatchObject({ outcome: "sold", standingOrderId: highOrder, userId: high.profileId });

      expect(await creditBalance(tx, high.profileId)).toBe(6000);
      expect(await creditBalance(tx, low.profileId)).toBe(10_000);
      const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
      expect(lead).toMatchObject({ status: "sold", soldToListingId: high.listingId, buyerUserId: high.authUserId });
      expect(lead!.soldAt).toBeInstanceOf(Date);
      const [purchase] = await tx.select().from(leadPurchases).where(eq(leadPurchases.leadId, leadId));
      expect(purchase).toMatchObject({ userId: high.profileId, listingId: high.listingId, standingOrderId: highOrder, priceCents: 4000 });
      const [debit] = await tx.select().from(creditLedger).where(eq(creditLedger.id, purchase!.ledgerId));
      expect(debit).toMatchObject({ deltaCents: -4000, kind: "purchase", refId: leadId });
      expect((await order(tx, highOrder)).wonCount).toBe(1);
      expect((await order(tx, lowOrder)).wonCount).toBe(0);
      expect(await jobs(tx, NOTIFY_LEAD_WON, "purchaseId", purchase!.id)).toBe(1);
    });
  });

  it("breaks a price tie by the older order", async () => {
    await withTestDb(async (tx) => {
      const ctx = await scaffold(tx);
      const a = await makeBuyer(tx, ctx, 10_000);
      const b = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, a, { priceCents: 3000, createdAt: T("20") });
      const older = await makeStandingOrder(tx, b, { priceCents: 3000, createdAt: T("10") });
      const out = await allocateLead(tx, PUBLIC_VIEWER, await makeLead(tx, ctx));
      expect(out).toMatchObject({ outcome: "sold", standingOrderId: older });
    });
  });

  it("matches a territory by the lead's city, the city's region slug, or national — and nothing else", async () => {
    await withTestDb(async (tx) => {
      const ctx = await scaffold(tx); // Leeds, West Yorkshire
      const elsewhere = await makeCity(tx, "Truro", "Cornwall");
      const cases: [string, object[], boolean][] = [
        ["city", [{ kind: "city", id: ctx.cityId }], true],
        ["region", [{ kind: "region", id: "west-yorkshire" }], true],
        ["national", [{ kind: "national" }], true],
        ["other city", [{ kind: "city", id: elsewhere }], false],
        ["other region", [{ kind: "region", id: "cornwall" }], false],
        ["any of several", [{ kind: "city", id: elsewhere }, { kind: "region", id: "west-yorkshire" }], true],
      ];
      for (const [label, territories, sells] of cases) {
        await tx.execute(sql`savepoint t`);
        const buyer = await makeBuyer(tx, ctx, 10_000);
        await makeStandingOrder(tx, buyer, { territories: territories as never });
        const out = await allocateLead(tx, PUBLIC_VIEWER, await makeLead(tx, ctx));
        expect(out.outcome, label).toBe(sells ? "sold" : "open");
        await tx.execute(sql`rollback to savepoint t`);
      }
    });
  });

  it("matches every category when category_ids is null, and only the listed ones otherwise", async () => {
    await withTestDb(async (tx) => {
      const ctx = await scaffold(tx);
      const other = await makeCategory(tx, ctx.verticalId, "Other Things");
      const cases: [string, string[] | null, string | null, boolean][] = [
        ["null = all", null, ctx.primaryCategoryId, true],
        ["null = all, uncategorised lead", null, null, true],
        ["listed", [other, ctx.primaryCategoryId], ctx.primaryCategoryId, true],
        ["not listed", [other], ctx.primaryCategoryId, false],
        ["list, uncategorised lead", [other], null, false],
      ];
      for (const [label, categoryIds, leadCategory, sells] of cases) {
        await tx.execute(sql`savepoint t`);
        const buyer = await makeBuyer(tx, ctx, 10_000);
        await makeStandingOrder(tx, buyer, { categoryIds });
        const out = await allocateLead(tx, PUBLIC_VIEWER, await makeLead(tx, { cityId: ctx.cityId, primaryCategoryId: leadCategory }));
        expect(out.outcome, label).toBe(sells ? "sold" : "open");
        await tx.execute(sql`rollback to savepoint t`);
      }
    });
  });

  it("skips an order that cannot afford its price: paused for no credit, one top-up email, and the next order wins", async () => {
    await withTestDb(async (tx) => {
      const ctx = await scaffold(tx);
      const broke = await makeBuyer(tx, ctx, 1000);
      const funded = await makeBuyer(tx, ctx, 10_000);
      const brokeOrder = await makeStandingOrder(tx, broke, { priceCents: 5000 });
      const fundedOrder = await makeStandingOrder(tx, funded, { priceCents: 2500 });

      const first = await allocateLead(tx, PUBLIC_VIEWER, await makeLead(tx, ctx));
      expect(first).toMatchObject({ outcome: "sold", standingOrderId: fundedOrder });
      expect(await creditBalance(tx, broke.profileId)).toBe(1000);
      expect(await order(tx, brokeOrder)).toMatchObject({ status: "paused", pausedReason: "no_credit" });
      expect(await jobs(tx, NOTIFY_LEAD_TOPUP, "standingOrderId", brokeOrder)).toBe(1);

      // Paused, so the next lead neither considers it nor mails it again.
      const second = await allocateLead(tx, PUBLIC_VIEWER, await makeLead(tx, ctx));
      expect(second).toMatchObject({ outcome: "sold", standingOrderId: fundedOrder });
      expect(await jobs(tx, NOTIFY_LEAD_TOPUP, "standingOrderId", brokeOrder)).toBe(1);
    });
  });

  it("also pauses a short order ranked below the winner, since it could not buy either", async () => {
    await withTestDb(async (tx) => {
      const ctx = await scaffold(tx);
      const funded = await makeBuyer(tx, ctx, 10_000);
      const broke = await makeBuyer(tx, ctx, 0);
      await makeStandingOrder(tx, funded, { priceCents: 5000 });
      const brokeOrder = await makeStandingOrder(tx, broke, { priceCents: 2500 });
      expect((await allocateLead(tx, PUBLIC_VIEWER, await makeLead(tx, ctx))).outcome).toBe("sold");
      expect(await order(tx, brokeOrder)).toMatchObject({ status: "paused", pausedReason: "no_credit" });
    });
  });

  it("leaves the lead open when nobody can buy it, and ignores paused orders and listings no longer owned", async () => {
    await withTestDb(async (tx) => {
      const ctx = await scaffold(tx);
      const paused = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, paused, { status: "paused", pausedReason: "user" });
      const sold = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, sold);
      await tx.execute(sql`update listings set owner_id = null where id = ${sold.listingId}`);

      const leadId = await makeLead(tx, ctx);
      expect(await allocateLead(tx, PUBLIC_VIEWER, leadId)).toMatchObject({ outcome: "open" });
      const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
      expect(lead!.status).toBe("open");
      expect(await tx.select().from(leadPurchases).where(eq(leadPurchases.leadId, leadId))).toHaveLength(0);
    });
  });

  it("does nothing to a lead that is not open", async () => {
    await withTestDb(async (tx) => {
      const ctx = await scaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, buyer);
      for (const status of ["sold", "expired", "deleted"] as const) {
        const leadId = await makeLead(tx, ctx, { status });
        expect(await allocateLead(tx, PUBLIC_VIEWER, leadId)).toEqual({ outcome: "not-open" });
      }
      expect(await creditBalance(tx, buyer.profileId)).toBe(10_000);
    });
  });
});

describe("retryAllocation", () => {
  it("offers open leads again to standing orders created or changed since the last run", async () => {
    await withTestDb(async (tx) => {
      const ctx = await scaffold(tx);
      const before = new Date("2026-09-25T09:00:00Z");
      const since = new Date("2026-09-25T10:50:00Z");
      const tick = new Date("2026-09-25T12:00:00Z");
      const waiting = await makeLead(tx, ctx, {}, before);
      const stale = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, stale, { territories: [{ kind: "city", id: "00000000-0000-4000-8000-000000000000" }], updatedAt: new Date("2026-09-25T11:30:00Z") });

      // Nothing new that covers it: left alone.
      expect(await retryAllocation(tx, PUBLIC_VIEWER, { since, at: tick })).toEqual({ checked: 0, sold: 0 });

      const fresh = await makeBuyer(tx, ctx, 10_000);
      const orderId = await makeStandingOrder(tx, fresh, { territories: [{ kind: "region", id: "west-yorkshire" }], updatedAt: new Date("2026-09-25T11:30:00Z") });
      expect(await retryAllocation(tx, PUBLIC_VIEWER, { since, at: tick })).toEqual({ checked: 1, sold: 1 });
      const [purchase] = await tx.select().from(leadPurchases).where(eq(leadPurchases.leadId, waiting));
      expect(purchase?.standingOrderId).toBe(orderId);
    });
  });
});
