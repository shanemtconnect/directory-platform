import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { auditLog } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeViewer } from "@/test/admin-fixtures";
import { makeScaffold } from "@/test/factories";
import { writeAudit } from "@/lib/db/queries/audit";
import { saveCityIntro } from "./cities";
import { AUDIT_PAGE_SIZE, auditEntityTypes, recentAudit } from "./audit";

describe("recentAudit", () => {
  it("returns the newest rows first and names the actor", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const older = await writeAudit(tx, admin, { action: "first.thing", entityType: "listing" });
      await saveCityIntro(tx, admin, ctx.cityId, "Copy.", { ip: null });

      // `created_at` defaults to now(), which in Postgres is the TRANSACTION's
      // clock — so every row this test writes shares a timestamp and the order
      // would be down to which uuid sorted first. Backdating one row is what
      // makes the assertion about the query rather than about luck.
      await tx
        .update(auditLog)
        .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
        .where(eq(auditLog.id, older));

      const rows = await recentAudit(tx, admin, null);
      expect(rows[0]?.action).toBe("city.intro_saved");
      expect(rows[1]?.action).toBe("first.thing");
      // The profile carries no name, so the account's own address identifies it.
      expect(rows[0]?.actor).toContain("@example.test");
    });
  });

  it("filters by entity type", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      await writeAudit(tx, admin, { action: "a.one", entityType: "listing" });
      await writeAudit(tx, admin, { action: "b.two", entityType: "city" });

      const rows = await recentAudit(tx, admin, "city");
      expect(rows.map((r) => r.action)).toEqual(["b.two"]);
    });
  });

  it("caps the page rather than reading the whole table", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      for (let n = 0; n < AUDIT_PAGE_SIZE + 3; n++) {
        await writeAudit(tx, admin, { action: `bulk.${n}`, entityType: "listing" });
      }
      const rows = await recentAudit(tx, admin, null);
      expect(rows).toHaveLength(AUDIT_PAGE_SIZE);
    });
  });

  it("leaves the actor null for a row nobody signed in wrote", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      await writeAudit(tx, PUBLIC_VIEWER, { action: "listing_submission.pending_city" });
      const rows = await recentAudit(tx, admin, null);
      expect(rows[0]?.actor).toBeNull();
    });
  });

  it("refuses anyone who is not an admin", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeViewer(tx, "owner");
      await expect(recentAudit(tx, owner, null)).rejects.toThrow("FORBIDDEN");
      await expect(recentAudit(tx, PUBLIC_VIEWER, null)).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("auditEntityTypes", () => {
  it("lists the types the filter can offer, sorted, without nulls", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      await writeAudit(tx, admin, { action: "a", entityType: "listing" });
      await writeAudit(tx, admin, { action: "b", entityType: "city" });
      await writeAudit(tx, admin, { action: "c", entityType: "city" });
      await writeAudit(tx, admin, { action: "d" });

      expect(await auditEntityTypes(tx, admin)).toEqual(["city", "listing"]);
    });
  });

  it("refuses anyone who is not an admin", async () => {
    await withTestDb(async (tx) => {
      await expect(auditEntityTypes(tx, PUBLIC_VIEWER)).rejects.toThrow("FORBIDDEN");
    });
  });
});
