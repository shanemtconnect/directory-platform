import { describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { jobQueue, leads } from "@/lib/db/schema";
import { makeScaffold } from "@/test/factories";
import { makeBuyer, makeLead, makeStandingOrder } from "@/test/leads";
import { NOTIFY_LEAD_BOARD_DIGEST } from "@/lib/email/notify";
/**
 * The retry job allocates each lead in its OWN top-level transaction on the
 * shared client, never inside the job's transaction. Here that client is
 * stood in for by the test transaction, and every call to it is counted.
 */
let current: TestDb | null = null;
const topLevel = vi.fn(async (fn: (tx: TestDb) => Promise<unknown>) => fn(current!));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: (tx: TestDb) => Promise<unknown>) => topLevel(fn) } }));

const { RETRY_LOOKBACK_MS, dispatchBoardDigest, runLeadsRetryAllocate, runLeadsSweep } = await import("./leads");

const NOW = new Date("2026-09-28T09:00:00Z"); // a Monday

describe("leads.sweep", () => {
  it("expires what is due and reports the counts", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const due = await makeLead(tx, ctx, { expiresAt: new Date(NOW.getTime() - 1000) });
      const out = await runLeadsSweep(tx, NOW);
      expect(out.expired).toBeGreaterThanOrEqual(1);
      const [row] = await tx.select({ status: leads.status }).from(leads).where(eq(leads.id, due));
      expect(row!.status).toBe("expired");
    });
  });
});

describe("leads.retry_allocate", () => {
  it("sells an open lead to an order created within the look-back window", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const leadId = await makeLead(tx, ctx, {}, new Date(NOW.getTime() - 5 * 3_600_000));
      const buyer = await makeBuyer(tx, ctx, 10_000);
      const second = await makeLead(tx, ctx, {}, new Date(NOW.getTime() - 4 * 3_600_000));
      await makeStandingOrder(tx, buyer, { territories: [{ kind: "city", id: ctx.cityId }], updatedAt: new Date(NOW.getTime() - RETRY_LOOKBACK_MS + 60_000) });
      current = tx;
      topLevel.mockClear();
      expect(await runLeadsRetryAllocate(tx, NOW)).toMatchObject({ checked: 2, sold: 2 });
      // One top-level transaction per lead: a win's locks are released before the next lead is locked.
      expect(topLevel).toHaveBeenCalledTimes(2);
      const rows = await tx.select({ status: leads.status }).from(leads).where(sql`${leads.id} in (${leadId}, ${second})`);
      expect(rows.map((r) => r.status)).toEqual(["sold", "sold"]);
    });
  });
});

describe("leads.board_digest", () => {
  it("queues one digest per eligible account, once per week", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 0);
      await makeStandingOrder(tx, buyer);
      await makeLead(tx, ctx, {}, NOW);
      await makeLead(tx, ctx, {}, NOW);
      const idle = await makeBuyer(tx, ctx, 0);
      await makeStandingOrder(tx, idle, { territories: [{ kind: "region", id: "nowhere-at-all" }] });
      const first = await dispatchBoardDigest(tx, NOW);
      expect(first.skipped).toBeUndefined();
      expect(first.queued).toBeGreaterThanOrEqual(1);
      const mine = await tx.select().from(jobQueue).where(and(eq(jobQueue.kind, NOTIFY_LEAD_BOARD_DIGEST), sql`${jobQueue.payload}->>'profileId' = ${buyer.profileId}`));
      expect(mine).toHaveLength(1);
      // The count is worked out once, at dispatch, from one read of the open leads.
      expect(mine[0]!.payload).toMatchObject({ profileId: buyer.profileId, openCount: 2 });
      // Nothing open in its places: no job at all.
      const idleJobs = await tx.select().from(jobQueue).where(and(eq(jobQueue.kind, NOTIFY_LEAD_BOARD_DIGEST), sql`${jobQueue.payload}->>'profileId' = ${idle.profileId}`));
      expect(idleJobs).toHaveLength(0);
      expect(await dispatchBoardDigest(tx, new Date(NOW.getTime() + 3_600_000))).toMatchObject({ skipped: "already-sent", queued: 0 });
    });
  });
});
