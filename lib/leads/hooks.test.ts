import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { leads } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { createCaptureLead } from "@/lib/db/queries/leads";
import { makeScaffold } from "@/test/factories";
import { afterLeadCreated, runAfterLeadCreated } from "./hooks";

async function aLead(tx: Parameters<typeof createCaptureLead>[0]) {
  const ctx = await makeScaffold(tx);
  const lead = await createCaptureLead(tx, PUBLIC_VIEWER, {
    cityId: ctx.cityId, categoryId: null, name: "Hook Test",
    email: `hook-${crypto.randomUUID()}@example.co.uk`,
    phone: `01632 97${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`,
    message: "A job for the hook test",
  });
  return lead!;
}

describe("afterLeadCreated", () => {
  it("is a no-op until Task 58 fills it", async () => {
    await withTestDb(async (tx) => {
      const lead = await aLead(tx);
      await expect(afterLeadCreated(tx, PUBLIC_VIEWER, lead)).resolves.toBeUndefined();
      expect(await runAfterLeadCreated(tx, PUBLIC_VIEWER, lead)).toBe(true);
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
