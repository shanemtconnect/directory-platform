import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { auditLog, claims, profiles, user } from "@/lib/db/schema";
import { makeListing, makeScaffold } from "@/test/factories";
import { resetClock, setClock } from "@/lib/clock";
import type { Viewer } from "@/lib/db/viewer";

/** Stands in for the bucket. Records what was asked for and what it refused. */
const deleted: string[] = [];
const deleteClaimDoc = vi.fn<(key: string) => Promise<void>>();
const claimDocsConfigured = vi.fn<() => boolean>();

vi.mock("@/lib/media/claim-docs", () => ({
  deleteClaimDoc: (key: string) => deleteClaimDoc(key),
  claimDocsConfigured: () => claimDocsConfigured(),
}));

const { attachClaimDocument, decideClaim, startDocumentClaim } =
  await import("@/lib/db/queries/claims");
const { purgeClaimDocuments } = await import("./purge-claim-docs");

beforeEach(() => {
  deleted.length = 0;
  deleteClaimDoc.mockReset().mockImplementation(async (key) => {
    deleted.push(key);
  });
  claimDocsConfigured.mockReset().mockReturnValue(true);
});

afterEach(() => resetClock());

async function person(tx: TestDb, role: "user" | "admin" = "user") {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({
    id: userId, name: "Jo", email: `${userId}@example.test`, emailVerified: true,
  });
  const [profile] = await tx.insert(profiles).values({ userId, role }).returning({ id: profiles.id });
  return { profileId: profile!.id, viewer: { role, userId } as Viewer };
}

/** A claim with a document, decided at the given instant. */
async function decidedClaim(tx: TestDb, at: Date) {
  setClock(at);
  const ctx = await makeScaffold(tx);
  const listingId = await makeListing(tx, ctx, { name: `L${randomUUID().slice(0, 6)}` });
  const jo = await person(tx);
  const started = await startDocumentClaim(tx, jo.viewer, {
    listingId, profileId: jo.profileId, claimantName: "Jo",
    roleAtBusiness: null, evidenceNotes: null, ip: null, userAgent: null,
  });
  if (started.outcome !== "open") throw new Error("setup failed");
  const key = `claims/${started.claimId}/proof-abc.pdf`;
  await attachClaimDocument(tx, jo.viewer, {
    claimId: started.claimId, profileId: jo.profileId, path: key,
  });
  const admin = await person(tx, "admin");
  await decideClaim(tx, admin.viewer, {
    claimId: started.claimId, decision: "rejected", reason: "No.",
    actorProfileId: admin.profileId, ip: null,
  });
  return { claimId: started.claimId, key };
}

describe("purgeClaimDocuments", () => {
  it("deletes the objects, nulls the paths and audits, 30 days after the decision", async () => {
    await withTestDb(async (tx) => {
      const { claimId, key } = await decidedClaim(tx, new Date("2026-01-01T00:00:00Z"));

      setClock(new Date("2026-02-05T00:00:00Z"));
      expect(await purgeClaimDocuments(tx)).toBe(1);
      expect(deleted).toEqual([key]);

      const [row] = await tx.select().from(claims).where(eq(claims.id, claimId));
      expect(row?.proofDocumentPath).toBeNull();
      expect(row?.documentsPurgedAt?.toISOString()).toBe("2026-02-05T00:00:00.000Z");

      const actions = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.action, "claim.documents_purged"));
      expect(actions).toHaveLength(1);
    });
  });

  it("leaves a claim decided inside the window completely alone", async () => {
    await withTestDb(async (tx) => {
      const { claimId, key } = await decidedClaim(tx, new Date("2026-01-01T00:00:00Z"));

      setClock(new Date("2026-01-29T00:00:00Z"));
      expect(await purgeClaimDocuments(tx)).toBe(0);
      expect(deleted).toEqual([]);

      const [row] = await tx.select().from(claims).where(eq(claims.id, claimId));
      expect(row?.proofDocumentPath).toBe(key);
      expect(row?.documentsPurgedAt).toBeNull();
    });
  });

  it("does nothing at all when R2 is unset, rather than failing every tick", async () => {
    await withTestDb(async (tx) => {
      claimDocsConfigured.mockReturnValue(false);
      const { claimId } = await decidedClaim(tx, new Date("2026-01-01T00:00:00Z"));

      setClock(new Date("2026-03-01T00:00:00Z"));
      expect(await purgeClaimDocuments(tx)).toBe(0);
      expect(deleteClaimDoc).not.toHaveBeenCalled();

      // And the row is NOT stamped: nothing was deleted, so claiming it was
      // would leave the document in a bucket with no record that it is there.
      const [row] = await tx.select().from(claims).where(eq(claims.id, claimId));
      expect(row?.documentsPurgedAt).toBeNull();
    });
  });

  it("keeps the path when the bucket refuses the delete, so the next tick retries", async () => {
    await withTestDb(async (tx) => {
      const { claimId, key } = await decidedClaim(tx, new Date("2026-01-01T00:00:00Z"));
      deleteClaimDoc.mockRejectedValue(new Error("R2 is having a day"));

      setClock(new Date("2026-03-01T00:00:00Z"));
      expect(await purgeClaimDocuments(tx)).toBe(0);

      const [row] = await tx.select().from(claims).where(eq(claims.id, claimId));
      expect(row?.proofDocumentPath).toBe(key);
      expect(row?.documentsPurgedAt).toBeNull();
    });
  });

  it("carries on past a claim it could not clear", async () => {
    await withTestDb(async (tx) => {
      const first = await decidedClaim(tx, new Date("2026-01-01T00:00:00Z"));
      const second = await decidedClaim(tx, new Date("2026-01-02T00:00:00Z"));
      deleteClaimDoc.mockImplementation(async (key) => {
        if (key === first.key) throw new Error("R2 is having a day");
        deleted.push(key);
      });

      setClock(new Date("2026-03-01T00:00:00Z"));
      expect(await purgeClaimDocuments(tx)).toBe(1);
      expect(deleted).toEqual([second.key]);

      const [stuck] = await tx.select().from(claims).where(eq(claims.id, first.claimId));
      expect(stuck?.documentsPurgedAt).toBeNull();
      const [done] = await tx.select().from(claims).where(eq(claims.id, second.claimId));
      expect(done?.documentsPurgedAt).not.toBeNull();
    });
  });

  it("does not pick the same claim up twice", async () => {
    await withTestDb(async (tx) => {
      await decidedClaim(tx, new Date("2026-01-01T00:00:00Z"));
      setClock(new Date("2026-03-01T00:00:00Z"));
      expect(await purgeClaimDocuments(tx)).toBe(1);
      expect(await purgeClaimDocuments(tx)).toBe(0);
      expect(deleteClaimDoc).toHaveBeenCalledTimes(1);
    });
  });
});
