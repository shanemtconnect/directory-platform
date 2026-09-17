import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { auditLog, profiles } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeViewer } from "@/test/admin-fixtures";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { writeAudit, writeAuditAs } from "./audit";

describe("writeAudit", () => {
  it("records the action against the actor's profile id, not the auth user id", async () => {
    await withTestDb(async (tx) => {
      const viewer = await makeViewer(tx);

      const id = await writeAudit(tx, viewer, {
        action: "submission.approved",
        entityType: "listing",
        entityId: "11111111-1111-4111-8111-111111111111",
        meta: { from: "pending", to: "published" },
        ip: "203.0.113.9",
      });

      const [row] = await tx.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
      expect(row?.action).toBe("submission.approved");
      expect(row?.entityType).toBe("listing");
      expect(row?.entityId).toBe("11111111-1111-4111-8111-111111111111");
      expect(row?.meta).toEqual({ from: "pending", to: "published" });
      expect(row?.ip).toBe("203.0.113.9");

      const [profile] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.userId, viewer.userId))
        .limit(1);
      expect(row?.actorId).toBe(profile?.id);
      expect(row?.actorId).not.toBe(viewer.userId);
    });
  });

  it("creates the profile on first sight so a new admin can act immediately", async () => {
    await withTestDb(async (tx) => {
      const viewer = await makeViewer(tx);
      const before = await tx.select().from(profiles).where(eq(profiles.userId, viewer.userId));
      expect(before).toHaveLength(0);

      await writeAudit(tx, viewer, { action: "city.published" });

      const after = await tx.select().from(profiles).where(eq(profiles.userId, viewer.userId));
      expect(after).toHaveLength(1);
    });
  });

  it("leaves the actor null for a write nobody signed in made", async () => {
    await withTestDb(async (tx) => {
      const id = await writeAudit(tx, PUBLIC_VIEWER, { action: "listing_submission.received" });
      const [row] = await tx.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
      expect(row?.actorId).toBeNull();
    });
  });

  it("reuses the profile rather than writing a second one", async () => {
    await withTestDb(async (tx) => {
      const viewer = await makeViewer(tx);
      await writeAudit(tx, viewer, { action: "city.published" });
      await writeAudit(tx, viewer, { action: "city.unpublished" });

      const rows = await tx.select().from(profiles).where(eq(profiles.userId, viewer.userId));
      expect(rows).toHaveLength(1);
    });
  });

  it("writes a null actor for the worker's nil-UUID viewer and invents no profile for it", async () => {
    await withTestDb(async (tx) => {
      const id = await writeAudit(tx, ADMIN_VIEWER, {
        action: "claim.documents_purged",
        entityType: "claim",
        entityId: "11111111-1111-4111-8111-111111111111",
      });

      const [row] = await tx.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
      expect(row?.actorId).toBeNull();
      const phantom = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.userId, ADMIN_VIEWER.role === "public" ? "" : ADMIN_VIEWER.userId));
      expect(phantom).toHaveLength(0);
    });
  });
});

describe("writeAuditAs", () => {
  it("records the row against the profile id it is given, with the same shape", async () => {
    await withTestDb(async (tx) => {
      const viewer = await makeViewer(tx);
      const first = await writeAudit(tx, viewer, { action: "claim.requested" });
      const [seed] = await tx.select().from(auditLog).where(eq(auditLog.id, first)).limit(1);
      const actorId = seed!.actorId!;

      const id = await writeAuditAs(tx, actorId, {
        action: "claim.document_uploaded",
        entityType: "claim",
        entityId: "11111111-1111-4111-8111-111111111111",
        meta: { slot: "proof" },
        ip: "203.0.113.9",
      });

      const [row] = await tx.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
      expect(row).toMatchObject({
        actorId,
        action: "claim.document_uploaded",
        entityType: "claim",
        entityId: "11111111-1111-4111-8111-111111111111",
        meta: { slot: "proof" },
        ip: "203.0.113.9",
      });
    });
  });

  it("accepts a null actor for system paths and defaults the optional columns to null", async () => {
    await withTestDb(async (tx) => {
      const id = await writeAuditAs(tx, null, { action: "billing.renewal_reminder" });
      const [row] = await tx.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
      expect(row).toMatchObject({
        actorId: null, entityType: null, entityId: null, meta: null, ip: null,
      });
    });
  });
});
