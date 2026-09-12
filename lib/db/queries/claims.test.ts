import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { auditLog, claims, listings, profiles, user } from "@/lib/db/schema";
import { resetClock, setClock } from "@/lib/clock";
import type { Viewer } from "@/lib/db/viewer";
import {
  attachClaimDocument,
  claimNotification,
  claimsForViewer,
  claimsWithPurgeableDocuments,
  decideClaim,
  getClaimForAdmin,
  getClaimableListing,
  listPendingClaims,
  markClaimDocumentsPurged,
  startDocumentClaim,
  startDomainClaim,
  verifyClaimToken,
} from "./claims";

afterEach(() => resetClock());

const ADMIN: Viewer = { role: "admin", userId: "admin-user" };

async function makeUser(tx: TestDb, role: "user" | "admin" = "user") {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({
    id: userId, name: "Jo Bloggs", email: `${userId}@example.test`, emailVerified: true,
  });
  const [profile] = await tx
    .insert(profiles)
    .values({ userId, role })
    .returning({ id: profiles.id });
  const viewer: Viewer = { role, userId };
  return { userId, profileId: profile!.id, viewer };
}

/** A published listing that advertises a domain, plus a signed-in claimant. */
async function scene(tx: TestDb, patch: Record<string, unknown> = {}) {
  const ctx = await makeScaffold(tx);
  const listingId = await makeListing(tx, ctx, {
    name: "The Old Mill", website: "https://www.oldmill.example", ...patch,
  });
  const claimant = await makeUser(tx);
  return { listingId, ...claimant };
}

describe("getClaimableListing", () => {
  it("returns the published listing with its path and website", async () => {
    await withTestDb(async (tx) => {
      const { listingId, viewer } = await scene(tx);
      const row = await getClaimableListing(tx, viewer, listingId);
      expect(row?.name).toBe("The Old Mill");
      expect(row?.website).toBe("https://www.oldmill.example");
      expect(row?.path).toMatch(/^\/[a-z0-9-]+\/the-old-mill$/);
    });
  });

  it("does not expose an unpublished listing to a signed-in user", async () => {
    await withTestDb(async (tx) => {
      const { listingId, viewer } = await scene(tx, { status: "pending" });
      expect(await getClaimableListing(tx, viewer, listingId)).toBeNull();
    });
  });

  it("returns null rather than throwing on an id that is not a uuid", async () => {
    await withTestDb(async (tx) => {
      const { viewer } = await scene(tx);
      expect(await getClaimableListing(tx, viewer, "not-a-uuid")).toBeNull();
    });
  });
});

describe("startDomainClaim", () => {
  it("mints a token for an address on the listing's own domain and audits it", async () => {
    await withTestDb(async (tx) => {
      const { listingId, profileId, viewer } = await scene(tx);
      const result = await startDomainClaim(tx, viewer, {
        listingId, profileId,
        businessEmail: "Jo@OldMill.example",
        claimantName: "Jo Bloggs",
        roleAtBusiness: "Owner",
        ip: "203.0.113.7",
        userAgent: "vitest",
      });
      expect(result.outcome).toBe("sent");
      if (result.outcome !== "sent") return;
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Stored lowercased — the address is an identifier, not a display name.
      expect(result.email).toBe("jo@oldmill.example");

      const [row] = await tx.select().from(claims).where(eq(claims.id, result.claimId));
      expect(row?.status).toBe("pending");
      expect(row?.evidenceType).toBe("domain_email");
      expect(row?.userId).toBe(profileId);
      expect(row?.ip).toBe("203.0.113.7");

      const audits = await tx
        .select({ action: auditLog.action, actorId: auditLog.actorId })
        .from(auditLog)
        .where(eq(auditLog.entityId, result.claimId));
      expect(audits).toEqual([{ action: "claim.requested", actorId: profileId }]);
    });
  });

  it("refuses a free-mail address even when the listing has no website", async () => {
    await withTestDb(async (tx) => {
      const { listingId, profileId, viewer } = await scene(tx, { website: null });
      const result = await startDomainClaim(tx, viewer, {
        listingId, profileId, businessEmail: "jo@gmail.com",
        claimantName: null, roleAtBusiness: null, ip: null, userAgent: null,
      });
      expect(result.outcome).toBe("domain-mismatch");
      expect(await tx.select().from(claims)).toHaveLength(0);
    });
  });

  it("reuses the one open claim rather than opening a second", async () => {
    await withTestDb(async (tx) => {
      const { listingId, profileId, viewer } = await scene(tx);
      const input = {
        listingId, profileId, businessEmail: "jo@oldmill.example",
        claimantName: null, roleAtBusiness: null, ip: null, userAgent: null,
      };
      const first = await startDomainClaim(tx, viewer, input);
      const second = await startDomainClaim(tx, viewer, input);
      expect(first.outcome).toBe("sent");
      expect(second.outcome).toBe("sent");
      if (first.outcome !== "sent" || second.outcome !== "sent") return;
      expect(second.claimId).toBe(first.claimId);
      // A fresh link, or a lost email would lock the claimant out for good.
      expect(second.token).not.toBe(first.token);
      expect(await tx.select().from(claims)).toHaveLength(1);
    });
  });

  it("will not start a claim on a listing somebody already owns", async () => {
    await withTestDb(async (tx) => {
      const { listingId, profileId, viewer } = await scene(tx, { claimStatus: "claimed" });
      const result = await startDomainClaim(tx, viewer, {
        listingId, profileId, businessEmail: "jo@oldmill.example",
        claimantName: null, roleAtBusiness: null, ip: null, userAgent: null,
      });
      expect(result.outcome).toBe("already-claimed");
    });
  });

  it("refuses an anonymous viewer outright", async () => {
    await withTestDb(async (tx) => {
      const { listingId, profileId } = await scene(tx);
      await expect(
        startDomainClaim(tx, { role: "public" }, {
          listingId, profileId, businessEmail: "jo@oldmill.example",
          claimantName: null, roleAtBusiness: null, ip: null, userAgent: null,
        }),
      ).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("verifyClaimToken", () => {
  async function requested(tx: TestDb) {
    const s = await scene(tx);
    const result = await startDomainClaim(tx, s.viewer, {
      listingId: s.listingId, profileId: s.profileId,
      businessEmail: "jo@oldmill.example",
      claimantName: null, roleAtBusiness: null, ip: null, userAgent: null,
    });
    if (result.outcome !== "sent") throw new Error("setup failed");
    return { ...s, token: result.token, claimId: result.claimId };
  }

  it("hands the listing to the claimant's profile and promotes them to owner", async () => {
    await withTestDb(async (tx) => {
      const { token, listingId, profileId } = await requested(tx);
      const result = await verifyClaimToken(tx, { role: "public" }, token);
      expect(result.outcome).toBe("approved");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.claimStatus).toBe("claimed");
      expect(listing?.ownerId).toBe(profileId);

      const [profile] = await tx.select().from(profiles).where(eq(profiles.id, profileId));
      expect(profile?.role).toBe("owner");

      const [claim] = await tx.select().from(claims).where(eq(claims.userId, profileId));
      expect(claim?.status).toBe("approved");
      expect(claim?.emailVerifiedAt).not.toBeNull();

      const actions = await tx.select({ action: auditLog.action }).from(auditLog);
      expect(actions.map((a) => a.action)).toContain("claim.approved");
    });
  });

  it("is idempotent, so a second click on the same link still reads as success", async () => {
    await withTestDb(async (tx) => {
      const { token } = await requested(tx);
      await verifyClaimToken(tx, { role: "public" }, token);
      const again = await verifyClaimToken(tx, { role: "public" }, token);
      expect(again.outcome).toBe("approved");
      const approvals = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.action, "claim.approved"));
      expect(approvals).toHaveLength(1);
    });
  });

  it("rejects a token past its 30-minute life", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-08T12:00:00Z"));
      const { token, listingId } = await requested(tx);
      setClock(new Date("2026-09-08T12:31:00Z"));
      expect((await verifyClaimToken(tx, { role: "public" }, token)).outcome).toBe("expired");
      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.claimStatus).toBe("unclaimed");
    });
  });

  it("does not recognise a token nobody issued", async () => {
    await withTestDb(async (tx) => {
      expect((await verifyClaimToken(tx, { role: "public" }, "made-up")).outcome).toBe("unknown");
      expect((await verifyClaimToken(tx, { role: "public" }, "")).outcome).toBe("unknown");
    });
  });

  it("stands down when somebody else claimed the listing in the meantime", async () => {
    await withTestDb(async (tx) => {
      const { token, listingId } = await requested(tx);
      await tx.update(listings).set({ claimStatus: "claimed" }).where(eq(listings.id, listingId));
      expect((await verifyClaimToken(tx, { role: "public" }, token)).outcome).toBe("already-claimed");
    });
  });

  it("never overwrites an owner, even on a listing still marked unclaimed", async () => {
    await withTestDb(async (tx) => {
      const { token, listingId, profileId } = await requested(tx);
      const squatter = await makeUser(tx);
      // The half-applied state a check-then-act race leaves behind: the row
      // has an owner while its status has not caught up. Taking it would hand
      // the listing away from somebody who already holds it.
      await tx.update(listings).set({ ownerId: squatter.profileId }).where(eq(listings.id, listingId));

      expect((await verifyClaimToken(tx, { role: "public" }, token)).outcome).toBe("already-claimed");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.ownerId).toBe(squatter.profileId);

      const [claim] = await tx.select().from(claims).where(eq(claims.userId, profileId));
      expect(claim?.status, "a claim that lost the race is not approved").toBe("pending");

      const [profile] = await tx.select().from(profiles).where(eq(profiles.id, profileId));
      expect(profile?.role, "and the loser is not promoted").toBe("user");

      const approvals = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.action, "claim.approved"));
      expect(approvals).toHaveLength(0);
    });
  });

  it("gives the listing to the first of two live tokens and refuses the second", async () => {
    await withTestDb(async (tx) => {
      const first = await requested(tx);
      const second = await makeUser(tx);
      const started = await startDomainClaim(tx, second.viewer, {
        listingId: first.listingId, profileId: second.profileId,
        businessEmail: "sam@oldmill.example",
        claimantName: null, roleAtBusiness: null, ip: null, userAgent: null,
      });
      if (started.outcome !== "sent") throw new Error("setup failed");

      expect((await verifyClaimToken(tx, { role: "public" }, first.token)).outcome).toBe("approved");
      expect((await verifyClaimToken(tx, { role: "public" }, started.token)).outcome)
        .toBe("already-claimed");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, first.listingId));
      expect(listing?.ownerId).toBe(first.profileId);

      const [loser] = await tx.select().from(profiles).where(eq(profiles.id, second.profileId));
      expect(loser?.role).toBe("user");

      const approvals = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.action, "claim.approved"));
      expect(approvals).toHaveLength(1);
    });
  });
});

describe("document claims", () => {
  it("opens a pending claim, takes the document path, and shows in the admin queue", async () => {
    await withTestDb(async (tx) => {
      const { listingId, profileId, viewer } = await scene(tx);
      const started = await startDocumentClaim(tx, viewer, {
        listingId, profileId,
        claimantName: "Jo Bloggs", roleAtBusiness: "Manager",
        evidenceNotes: "Utility bill", ip: null, userAgent: null,
      });
      expect(started.outcome).toBe("open");
      if (started.outcome !== "open") return;

      const attached = await attachClaimDocument(tx, viewer, {
        claimId: started.claimId, profileId, path: `claims/${started.claimId}/proof.pdf`,
        ip: "203.0.113.7",
      });
      expect(attached).toBe(true);

      // Global constraint 22: an upload of somebody's identity document is
      // recorded with the address it arrived from.
      const uploads = await tx
        .select({ actorId: auditLog.actorId, ip: auditLog.ip })
        .from(auditLog)
        .where(eq(auditLog.action, "claim.document_uploaded"));
      expect(uploads).toEqual([{ actorId: profileId, ip: "203.0.113.7" }]);

      const queue = await listPendingClaims(tx, ADMIN);
      expect(queue).toHaveLength(1);
      expect(queue[0]?.listingName).toBe("The Old Mill");
      expect(queue[0]?.hasDocument).toBe(true);
    });
  });

  it("will not let one user attach a document to another user's claim", async () => {
    await withTestDb(async (tx) => {
      const { listingId, profileId, viewer } = await scene(tx);
      const started = await startDocumentClaim(tx, viewer, {
        listingId, profileId, claimantName: null, roleAtBusiness: null,
        evidenceNotes: null, ip: null, userAgent: null,
      });
      if (started.outcome !== "open") throw new Error("setup failed");
      const intruder = await makeUser(tx);
      const attached = await attachClaimDocument(tx, intruder.viewer, {
        claimId: started.claimId, profileId: intruder.profileId, path: "claims/x/proof.pdf",
        ip: null,
      });
      expect(attached).toBe(false);
    });
  });

  it("keeps the queue and the detail view away from non-admins", async () => {
    await withTestDb(async (tx) => {
      const { viewer } = await scene(tx);
      await expect(listPendingClaims(tx, viewer)).rejects.toThrow(/FORBIDDEN/);
      await expect(getClaimForAdmin(tx, viewer, randomUUID())).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("decideClaim", () => {
  async function pending(tx: TestDb) {
    const s = await scene(tx);
    const started = await startDocumentClaim(tx, s.viewer, {
      listingId: s.listingId, profileId: s.profileId,
      claimantName: null, roleAtBusiness: null, evidenceNotes: null, ip: null, userAgent: null,
    });
    if (started.outcome !== "open") throw new Error("setup failed");
    await attachClaimDocument(tx, s.viewer, {
      claimId: started.claimId, profileId: s.profileId, path: "claims/p/proof.pdf", ip: null,
    });
    const admin = await makeUser(tx, "admin");
    return { ...s, claimId: started.claimId, admin };
  }

  it("approves: listing owned, claimant promoted, decision recorded and audited", async () => {
    await withTestDb(async (tx) => {
      const { claimId, listingId, profileId, admin } = await pending(tx);
      const out = await decideClaim(tx, admin.viewer, {
        claimId, decision: "approved", reason: null,
        actorProfileId: admin.profileId, ip: "203.0.113.9",
      });
      expect(out.outcome).toBe("decided");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.claimStatus).toBe("claimed");
      expect(listing?.ownerId).toBe(profileId);

      const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId));
      expect(claim?.status).toBe("approved");
      expect(claim?.decidedBy).toBe(admin.profileId);
      expect(claim?.decidedAt).not.toBeNull();

      const actions = await tx.select({ action: auditLog.action }).from(auditLog);
      expect(actions.map((a) => a.action)).toContain("claim.approved");
    });
  });

  it("rejects with a reason and leaves the listing unclaimed", async () => {
    await withTestDb(async (tx) => {
      const { claimId, listingId, admin } = await pending(tx);
      const out = await decideClaim(tx, admin.viewer, {
        claimId, decision: "rejected", reason: "The document does not name the business.",
        actorProfileId: admin.profileId, ip: null,
      });
      expect(out.outcome).toBe("decided");

      const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId));
      expect(claim?.status).toBe("rejected");
      expect(claim?.rejectionReason).toBe("The document does not name the business.");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.claimStatus).toBe("unclaimed");
      expect(listing?.ownerId).toBeNull();
    });
  });

  it("insists on a reason for a rejection", async () => {
    await withTestDb(async (tx) => {
      const { claimId, admin } = await pending(tx);
      const out = await decideClaim(tx, admin.viewer, {
        claimId, decision: "rejected", reason: "   ",
        actorProfileId: admin.profileId, ip: null,
      });
      expect(out.outcome).toBe("reason-required");
    });
  });

  it("refuses to approve onto a listing that already has an owner", async () => {
    await withTestDb(async (tx) => {
      const { claimId, listingId, profileId, admin } = await pending(tx);
      const squatter = await makeUser(tx);
      await tx.update(listings).set({ ownerId: squatter.profileId }).where(eq(listings.id, listingId));

      const out = await decideClaim(tx, admin.viewer, {
        claimId, decision: "approved", reason: null,
        actorProfileId: admin.profileId, ip: null,
      });
      expect(out.outcome).toBe("already-decided");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.ownerId).toBe(squatter.profileId);

      const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId));
      expect(claim?.status).toBe("pending");

      const [profile] = await tx.select().from(profiles).where(eq(profiles.id, profileId));
      expect(profile?.role).toBe("user");

      const approvals = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.action, "claim.approved"));
      expect(approvals).toHaveLength(0);
    });
  });

  it("lets the first of two approvals take the listing and no more", async () => {
    await withTestDb(async (tx) => {
      const first = await pending(tx);
      const rival = await makeUser(tx);
      const started = await startDocumentClaim(tx, rival.viewer, {
        listingId: first.listingId, profileId: rival.profileId,
        claimantName: null, roleAtBusiness: null, evidenceNotes: null, ip: null, userAgent: null,
      });
      if (started.outcome !== "open") throw new Error("setup failed");

      expect((await decideClaim(tx, first.admin.viewer, {
        claimId: first.claimId, decision: "approved", reason: null,
        actorProfileId: first.admin.profileId, ip: null,
      })).outcome).toBe("decided");

      expect((await decideClaim(tx, first.admin.viewer, {
        claimId: started.claimId, decision: "approved", reason: null,
        actorProfileId: first.admin.profileId, ip: null,
      })).outcome).toBe("already-decided");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, first.listingId));
      expect(listing?.ownerId).toBe(first.profileId);

      const [lost] = await tx.select().from(claims).where(eq(claims.id, started.claimId));
      expect(lost?.status, "the losing claim stays pending for a human to close").toBe("pending");

      const approvals = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.action, "claim.approved"));
      expect(approvals).toHaveLength(1);
    });
  });

  it("will not decide the same claim twice", async () => {
    await withTestDb(async (tx) => {
      const { claimId, admin } = await pending(tx);
      const first = { claimId, decision: "approved" as const, reason: null, actorProfileId: admin.profileId, ip: null };
      expect((await decideClaim(tx, admin.viewer, first)).outcome).toBe("decided");
      expect((await decideClaim(tx, admin.viewer, first)).outcome).toBe("already-decided");
    });
  });

  it("is closed to everybody but an admin", async () => {
    await withTestDb(async (tx) => {
      const { claimId, viewer, profileId } = await pending(tx);
      await expect(
        decideClaim(tx, viewer, {
          claimId, decision: "approved", reason: null, actorProfileId: profileId, ip: null,
        }),
      ).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("claimNotification", () => {
  it("gives the worker the token, the address and the listing, admin-only", async () => {
    await withTestDb(async (tx) => {
      const { listingId, profileId, viewer } = await scene(tx);
      const started = await startDomainClaim(tx, viewer, {
        listingId, profileId, businessEmail: "jo@oldmill.example",
        claimantName: "Jo", roleAtBusiness: null, ip: null, userAgent: null,
      });
      if (started.outcome !== "sent") throw new Error("setup failed");

      await expect(claimNotification(tx, viewer, started.claimId)).rejects.toThrow(/FORBIDDEN/);

      const data = await claimNotification(tx, ADMIN, started.claimId);
      expect(data?.businessEmail).toBe("jo@oldmill.example");
      expect(data?.magicToken).toBe(started.token);
      expect(data?.listingName).toBe("The Old Mill");
      expect(data?.listingPath).toMatch(/^\//);
    });
  });
});

describe("the 30-day document purge", () => {
  async function decided(tx: TestDb) {
    const s = await scene(tx);
    const started = await startDocumentClaim(tx, s.viewer, {
      listingId: s.listingId, profileId: s.profileId,
      claimantName: null, roleAtBusiness: null, evidenceNotes: null, ip: null, userAgent: null,
    });
    if (started.outcome !== "open") throw new Error("setup failed");
    await attachClaimDocument(tx, s.viewer, {
      claimId: started.claimId, profileId: s.profileId, path: "claims/p/proof.pdf", ip: null,
    });
    const admin = await makeUser(tx, "admin");
    await decideClaim(tx, admin.viewer, {
      claimId: started.claimId, decision: "rejected", reason: "No.",
      actorProfileId: admin.profileId, ip: null,
    });
    return { ...s, claimId: started.claimId, admin };
  }

  it("ignores a claim decided inside the retention window and picks it up after", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-01-01T00:00:00Z"));
      const { claimId } = await decided(tx);

      setClock(new Date("2026-01-30T00:00:00Z"));
      expect(await claimsWithPurgeableDocuments(tx, ADMIN)).toHaveLength(0);

      setClock(new Date("2026-02-01T00:00:01Z"));
      const due = await claimsWithPurgeableDocuments(tx, ADMIN);
      expect(due).toEqual([
        { id: claimId, paths: ["claims/p/proof.pdf"] },
      ]);
    });
  });

  it("nulls the paths, stamps the purge and audits it — and does not come back", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-01-01T00:00:00Z"));
      const { claimId } = await decided(tx);
      setClock(new Date("2026-03-01T00:00:00Z"));

      await markClaimDocumentsPurged(tx, ADMIN, claimId, ["claims/p/proof.pdf"]);

      const [row] = await tx.select().from(claims).where(eq(claims.id, claimId));
      expect(row?.proofDocumentPath).toBeNull();
      expect(row?.idDocumentPath).toBeNull();
      expect(row?.documentsPurgedAt?.toISOString()).toBe("2026-03-01T00:00:00.000Z");

      expect(await claimsWithPurgeableDocuments(tx, ADMIN)).toHaveLength(0);

      const actions = await tx.select({ action: auditLog.action }).from(auditLog);
      expect(actions.map((a) => a.action)).toContain("claim.documents_purged");
    });
  });

  it("is not something a signed-in user can run", async () => {
    await withTestDb(async (tx) => {
      const { viewer } = await scene(tx);
      await expect(claimsWithPurgeableDocuments(tx, viewer)).rejects.toThrow(/FORBIDDEN/);
      await expect(markClaimDocumentsPurged(tx, viewer, randomUUID(), [])).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("claimsForViewer", () => {
  it("returns the claimant's own claims with the LISTING id for the retry link", async () => {
    await withTestDb(async (tx) => {
      const { listingId, profileId, viewer } = await scene(tx);
      const started = await startDomainClaim(tx, viewer, {
        listingId, profileId, businessEmail: "jo@oldmill.example",
        claimantName: null, roleAtBusiness: null, ip: null, userAgent: null,
      });
      if (started.outcome !== "sent") throw new Error("setup failed");

      const mine = await claimsForViewer(tx, viewer);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.listingId).toBe(listingId);
      expect(mine[0]?.status).toBe("pending");

      // Scoped by the viewer's own profile, so another account sees nothing.
      const stranger = await makeUser(tx);
      expect(await claimsForViewer(tx, stranger.viewer)).toEqual([]);
    });
  });

  it("is closed to an anonymous viewer", async () => {
    await withTestDb(async (tx) => {
      await scene(tx);
      await expect(claimsForViewer(tx, { role: "public" })).rejects.toThrow(/FORBIDDEN/);
    });
  });
});
