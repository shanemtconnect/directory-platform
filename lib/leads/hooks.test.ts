import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { leadPurchases, leads } from "@/lib/db/schema";
import { makeBuyer, makeStandingOrder } from "@/test/leads";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { createCaptureLead } from "@/lib/db/queries/leads";
import { makeScaffold, type ListingCtx } from "@/test/factories";
import { afterLeadCreated, runAfterLeadCreated } from "./hooks";

async function aLead(tx: Parameters<typeof createCaptureLead>[0], given?: ListingCtx) {
  const ctx = given ?? await makeScaffold(tx);
  const lead = await createCaptureLead(tx, PUBLIC_VIEWER, {
    cityId: ctx.cityId, categoryId: null, name: "Hook Test",
    email: `hook-${crypto.randomUUID()}@example.co.uk`,
    phone: `01632 97${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`,
    message: "A job for the hook test",
  });
  return lead!;
}

describe("afterLeadCreated", () => {
  it("leaves a lead open on the board when no standing order covers it", async () => {
    await withTestDb(async (tx) => {
      const lead = await aLead(tx);
      await expect(afterLeadCreated(tx, PUBLIC_VIEWER, lead)).resolves.toBeUndefined();
      expect(await runAfterLeadCreated(tx, PUBLIC_VIEWER, lead)).toBe(true);
      const [row] = await tx.select({ status: leads.status }).from(leads).where(eq(leads.id, lead.id));
      expect(row?.status).toBe("open");
    });
  });

  it("allocates: a covering standing order that can pay buys the lead the moment it is made", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const lead = await aLead(tx, ctx);
      const buyer = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, buyer, { territories: [{ kind: "city", id: lead.cityId }] });
      expect(await runAfterLeadCreated(tx, PUBLIC_VIEWER, lead)).toBe(true);
      const [row] = await tx.select({ status: leads.status }).from(leads).where(eq(leads.id, lead.id));
      expect(row?.status).toBe("sold");
      expect(await tx.select().from(leadPurchases).where(eq(leadPurchases.leadId, lead.id))).toHaveLength(1);
    });
  });

  it("a hook that throws is logged, rolled back to its savepoint, and leaves the lead open", async () => {
    await withTestDb(async (tx) => {
      const lead = await aLead(tx);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const ok = await runAfterLeadCreated(tx, PUBLIC_VIEWER, lead, async (sp) => {
        await sp.update(leads).set({ status: "sold" }).where(eq(leads.id, lead.id));
        throw new Error("allocation exploded");
      });
      expect(ok).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("allocation exploded"));
      error.mockRestore();
      // The outer transaction is still usable, and the hook's write is gone.
      const [row] = await tx.select({ status: leads.status }).from(leads).where(eq(leads.id, lead.id));
      expect(row?.status).toBe("open");
    });
  });
});
