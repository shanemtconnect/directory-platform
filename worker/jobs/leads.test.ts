import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { jobQueue, leads } from "@/lib/db/schema";
import { makeScaffold } from "@/test/factories";
import { makeBuyer, makeLead, makeStandingOrder } from "@/test/leads";
import { NOTIFY_LEAD_BOARD_DIGEST } from "@/lib/email/notify";
import { RETRY_LOOKBACK_MS, dispatchBoardDigest, runLeadsRetryAllocate, runLeadsSweep } from "./leads";

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
      await makeStandingOrder(tx, buyer, { territories: [{ kind: "city", id: ctx.cityId }], updatedAt: new Date(NOW.getTime() - RETRY_LOOKBACK_MS + 60_000) });
      expect(await runLeadsRetryAllocate(tx, NOW)).toMatchObject({ sold: 1 });
      const [row] = await tx.select({ status: leads.status }).from(leads).where(eq(leads.id, leadId));
      expect(row!.status).toBe("sold");
    });
  });
});

describe("leads.board_digest", () => {
  it("queues one digest per eligible account, once per week", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 0);
      await makeStandingOrder(tx, buyer);
      const first = await dispatchBoardDigest(tx, NOW);
      expect(first.skipped).toBeUndefined();
      expect(first.queued).toBeGreaterThanOrEqual(1);
      const mine = await tx.select().from(jobQueue).where(and(eq(jobQueue.kind, NOTIFY_LEAD_BOARD_DIGEST), sql`${jobQueue.payload}->>'profileId' = ${buyer.profileId}`));
      expect(mine).toHaveLength(1);
      expect(await dispatchBoardDigest(tx, new Date(NOW.getTime() + 3_600_000))).toMatchObject({ skipped: "already-sent", queued: 0 });
    });
  });
});
