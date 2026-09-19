import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import {
  auditLog,
  jobQueue,
  listings,
  removalRequests,
  reports,
  suppressions,
  user,
} from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { makeListing, makeScaffold } from "@/test/factories";
import { checkSuppressed } from "@/lib/import/guardrails";
import { setClock, resetClock } from "@/lib/clock";
import { NOTIFY_REMOVAL_ACTIONED, NOTIFY_REMOVAL_REJECTED } from "@/lib/email/notify";
import {
  actionRemovalRequest,
  actionReport,
  createRemovalRequest,
  createReport,
  listOpenRemovalRequests,
  listOpenReports,
  removalDecisionNotification,
  removalNotification,
  reportNotification,
  trustTarget,
} from "./trust";

/** An admin viewer whose user row exists, so `ensureProfile` can bridge it. */
async function makeAdmin(tx: TestDb): Promise<Viewer & { role: "admin" }> {
  const userId = `u_${randomUUID()}`;
  await tx
    .insert(user)
    .values({ id: userId, name: "Mo Moderator", email: `${userId}@example.test`, emailVerified: true });
  return { role: "admin", userId };
}

const USER: Viewer = { role: "user", userId: "u_not_an_admin" };

describe("createReport", () => {
  it("files the report against a published listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });

      const result = await createReport(tx, PUBLIC_VIEWER, {
        listingId,
        reason: "closed",
        detail: "They shut in March; the sign is down.",
        reporterEmail: "spotter@example.co.uk",
        ip: "198.51.100.7",
      });

      expect(result.outcome).toBe("created");
      const [row] = await tx.select().from(reports).where(eq(reports.listingId, listingId));
      expect(row).toMatchObject({
        reason: "closed",
        detail: "They shut in March; the sign is down.",
        reporterEmail: "spotter@example.co.uk",
        status: "open",
        ip: "198.51.100.7",
      });
    });
  });

  it("accepts a report with no reporter email", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      const result = await createReport(tx, PUBLIC_VIEWER, {
        listingId,
        reason: "incorrect",
        detail: null,
        reporterEmail: null,
        ip: null,
      });

      expect(result.outcome).toBe("created");
      const [row] = await tx.select().from(reports).where(eq(reports.listingId, listingId));
      expect(row?.reporterEmail).toBeNull();
      expect(row?.ip).toBeNull();
    });
  });

  it("refuses a listing the public cannot see", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { status: "pending" });

      const result = await createReport(tx, PUBLIC_VIEWER, {
        listingId,
        reason: "other",
        detail: null,
        reporterEmail: null,
        ip: null,
      });

      expect(result.outcome).toBe("unknown-listing");
      expect(await tx.select().from(reports).where(eq(reports.listingId, listingId))).toHaveLength(0);
    });
  });

  it("treats an id that is not a uuid as an unknown listing rather than erroring", async () => {
    await withTestDb(async (tx) => {
      const result = await createReport(tx, PUBLIC_VIEWER, {
        listingId: "not-a-uuid",
        reason: "other",
        detail: null,
        reporterEmail: null,
        ip: null,
      });
      expect(result.outcome).toBe("unknown-listing");
    });
  });
});

describe("createRemovalRequest", () => {
  it("files the request with a due date five working days out", async () => {
    setClock(new Date("2026-06-12T10:00:00Z")); // A Friday.
    try {
      await withTestDb(async (tx) => {
        const ctx = await makeScaffold(tx);
        const listingId = await makeListing(tx, ctx);

        const result = await createRemovalRequest(tx, PUBLIC_VIEWER, {
          listingId,
          requesterName: "Alex Owner",
          requesterEmail: "alex@example.co.uk",
          relationship: "owner",
          reason: "I never asked to be listed.",
          ip: null,
        });

        expect(result.outcome).toBe("created");
        if (result.outcome !== "created") return;
        expect(result.dueAt.toISOString()).toBe("2026-06-19T10:00:00.000Z");

        const [row] = await tx
          .select()
          .from(removalRequests)
          .where(eq(removalRequests.listingId, listingId));
        expect(row).toMatchObject({
          requesterName: "Alex Owner",
          requesterEmail: "alex@example.co.uk",
          relationship: "owner",
          status: "open",
        });
        expect(row?.dueAt?.toISOString()).toBe("2026-06-19T10:00:00.000Z");
      });
    } finally {
      resetClock();
    }
  });

  it("refuses a listing the public cannot see", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { status: "archived" });

      const result = await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Alex Owner",
        requesterEmail: "alex@example.co.uk",
        relationship: "owner",
        reason: null,
        ip: null,
      });

      expect(result.outcome).toBe("unknown-listing");
      expect(
        await tx.select().from(removalRequests).where(eq(removalRequests.listingId, listingId)),
      ).toHaveLength(0);
    });
  });
});

describe("the admin queues", () => {
  it("refuse a viewer who is not an admin", async () => {
    await withTestDb(async (tx) => {
      await expect(listOpenReports(tx, PUBLIC_VIEWER)).rejects.toThrow(/FORBIDDEN/);
      await expect(listOpenReports(tx, USER)).rejects.toThrow(/FORBIDDEN/);
      await expect(listOpenRemovalRequests(tx, PUBLIC_VIEWER)).rejects.toThrow(/FORBIDDEN/);
      await expect(listOpenRemovalRequests(tx, USER)).rejects.toThrow(/FORBIDDEN/);
    });
  });

  it("list open items with the listing they are about, newest first", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });

      await createReport(tx, PUBLIC_VIEWER, {
        listingId, reason: "duplicate", detail: "Listed twice.", reporterEmail: null, ip: null,
      });
      await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Alex Owner",
        requesterEmail: "alex@example.co.uk",
        relationship: "owner",
        reason: null,
        ip: null,
      });

      const openReports = await listOpenReports(tx, admin);
      expect(openReports).toHaveLength(1);
      expect(openReports[0]).toMatchObject({
        listingId,
        listingName: "The Old Mill",
        reason: "duplicate",
        detail: "Listed twice.",
      });
      expect(openReports[0]?.listingPath).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);

      const openRemovals = await listOpenRemovalRequests(tx, admin);
      expect(openRemovals).toHaveLength(1);
      expect(openRemovals[0]).toMatchObject({
        listingId,
        listingName: "The Old Mill",
        requesterEmail: "alex@example.co.uk",
        relationship: "owner",
      });
    });
  });

  it("leave a decided item out of the queue", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      const filed = await createReport(tx, PUBLIC_VIEWER, {
        listingId, reason: "incorrect", detail: null, reporterEmail: null, ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      await actionReport(tx, admin, filed.reportId, "dismissed", { ip: null });
      expect(await listOpenReports(tx, admin)).toHaveLength(0);
    });
  });
});

describe("actionReport", () => {
  it("records the decision and an audit row", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const filed = await createReport(tx, PUBLIC_VIEWER, {
        listingId, reason: "incorrect", detail: null, reporterEmail: null, ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      const result = await actionReport(tx, admin, filed.reportId, "actioned", {
        ip: "203.0.113.5",
      });
      expect(result.outcome).toBe("updated");

      const [row] = await tx.select().from(reports).where(eq(reports.id, filed.reportId));
      expect(row?.status).toBe("actioned");

      const audit = await tx.select().from(auditLog).where(eq(auditLog.entityId, filed.reportId));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe("report.actioned");
      expect(audit[0]?.actorId).not.toBeNull();
      // The moderator's own IP, for the audit trail — global constraint 22.
      expect(audit[0]?.ip).toBe("203.0.113.5");
    });
  });

  it("refuses a viewer who is not an admin and changes nothing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const filed = await createReport(tx, PUBLIC_VIEWER, {
        listingId, reason: "incorrect", detail: null, reporterEmail: null, ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      expect((await actionReport(tx, USER, filed.reportId, "actioned", { ip: null })).outcome).toBe("forbidden");
      const [row] = await tx.select().from(reports).where(eq(reports.id, filed.reportId));
      expect(row?.status).toBe("open");
    });
  });

  it("will not decide the same report twice", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const filed = await createReport(tx, PUBLIC_VIEWER, {
        listingId, reason: "incorrect", detail: null, reporterEmail: null, ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      await actionReport(tx, admin, filed.reportId, "dismissed", { ip: null });
      const again = await actionReport(tx, admin, filed.reportId, "actioned", { ip: null });
      expect(again.outcome).toBe("not-open");

      const [row] = await tx.select().from(reports).where(eq(reports.id, filed.reportId));
      expect(row?.status).toBe("dismissed");
    });
  });

  it("reports an unknown id rather than erroring", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      expect((await actionReport(tx, admin, randomUUID(), "actioned", { ip: null })).outcome).toBe("unknown");
      expect((await actionReport(tx, admin, "not-a-uuid", "actioned", { ip: null })).outcome).toBe("unknown");
    });
  });
});

describe("actionRemovalRequest", () => {
  it("removes the listing and suppresses it so a re-import cannot bring it back", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, {
        name: "The Old Barn",
        postcode: "LS1 4AP",
        phone: "(0113) 496-0000",
        email: "hello@theoldbarn.example",
      });
      const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Alex Owner",
        requesterEmail: "alex@example.co.uk",
        relationship: "owner",
        reason: null,
        ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      const result = await actionRemovalRequest(tx, admin, filed.removalRequestId, {
        decision: "actioned",
        ip: "203.0.113.9",
      });
      expect(result.outcome).toBe("updated");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.status).toBe("removed");

      const [row] = await tx
        .select()
        .from(removalRequests)
        .where(eq(removalRequests.id, filed.removalRequestId));
      expect(row?.status).toBe("actioned");
      expect(row?.actionedAt).not.toBeNull();
      expect(row?.actionedBy).not.toBeNull();

      // The suppression row is normalised exactly as the importer normalises
      // the file it checks against, or the guard silently never matches.
      const [block] = await tx.select().from(suppressions);
      expect(block).toMatchObject({
        nameNormalised: "the old barn",
        postcodeNormalised: "ls14ap",
        email: "hello@theoldbarn.example",
        phone: "(0113) 496-0000",
      });
      expect(block?.createdBy).not.toBeNull();

      // And the importer's own guard agrees, however the feed is shaped.
      expect(
        await checkSuppressed(tx, admin, {
          name: "THE OLD BARN", city: "Leeds", category: "Barn", postcode: "ls1  4ap",
        }),
      ).toBe(true);
      expect(
        await checkSuppressed(tx, admin, {
          name: "the old barn", city: "Leeds", category: "Barn", phone: "01134960000",
        }),
      ).toBe(true);
      expect(
        await checkSuppressed(tx, admin, {
          name: "A Different Barn", city: "Leeds", category: "Barn", postcode: "LS1 4AP",
        }),
      ).toBe(false);

      const audit = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, filed.removalRequestId));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe("removal_request.actioned");
      expect(audit[0]?.ip).toBe("203.0.113.9");

      // The copy on every removal page promises an email "when it is done" —
      // enqueued in the same transaction as the decision, not left for a
      // caller to remember.
      const jobs = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_REMOVAL_ACTIONED));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toMatchObject({ removalRequestId: filed.removalRequestId });
    });
  });

  it("writes no suppression and leaves the listing alone when the request is rejected", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Someone Else",
        requesterEmail: "someone@example.co.uk",
        relationship: "other",
        reason: null,
        ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      const result = await actionRemovalRequest(tx, admin, filed.removalRequestId, {
        decision: "rejected",
        reason: "The request came from somebody with no connection to the entry.",
        ip: null,
      });
      expect(result.outcome).toBe("updated");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.status).toBe("published");
      expect(await tx.select().from(suppressions)).toHaveLength(0);

      // A "no" is still an answer the requester was promised, not silence.
      const jobs = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_REMOVAL_REJECTED));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toMatchObject({ removalRequestId: filed.removalRequestId });
      expect(await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_REMOVAL_ACTIONED)))
        .toHaveLength(0);
    });
  });

  it("keeps the reason for a rejection on the row and in the audit trail", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Someone Else",
        requesterEmail: "someone@example.co.uk",
        relationship: "other",
        reason: null,
        ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      const reason = "  The request came from somebody with no connection to the entry.  ";
      const result = await actionRemovalRequest(tx, admin, filed.removalRequestId, {
        decision: "rejected",
        reason,
        ip: "203.0.113.5",
      });
      expect(result.outcome).toBe("updated");

      const [row] = await tx
        .select()
        .from(removalRequests)
        .where(eq(removalRequests.id, filed.removalRequestId));
      expect(row?.status).toBe("rejected");
      expect(row?.rejectionReason).toBe(reason.trim());

      // The reason is what a contested "no" is argued from, so it sits on the
      // audit row as well as on the request.
      const audit = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, filed.removalRequestId));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe("removal_request.rejected");
      expect(audit[0]?.meta).toMatchObject({ listingId, reason: reason.trim() });
      expect(audit[0]?.ip).toBe("203.0.113.5");
    });
  });

  it("will not reject without a reason the requester can be told", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Someone Else",
        requesterEmail: "someone@example.co.uk",
        relationship: "other",
        reason: null,
        ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      for (const reason of ["", "   ", "too short", "   nine ch  "]) {
        const result = await actionRemovalRequest(tx, admin, filed.removalRequestId, {
          decision: "rejected",
          reason,
          ip: null,
        });
        expect(result.outcome).toBe("reason-required");
      }

      // Nothing moved: still open, no audit row, no email queued.
      const [row] = await tx
        .select()
        .from(removalRequests)
        .where(eq(removalRequests.id, filed.removalRequestId));
      expect(row?.status).toBe("open");
      expect(row?.rejectionReason).toBeNull();
      expect(await tx.select().from(auditLog)).toHaveLength(0);
      expect(await tx.select().from(jobQueue)).toHaveLength(0);
    });
  });

  it("leaves the rejection reason empty on a takedown", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Alex Owner",
        requesterEmail: "alex@example.co.uk",
        relationship: "owner",
        reason: null,
        ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      await actionRemovalRequest(tx, admin, filed.removalRequestId, { decision: "actioned", ip: null });

      const [row] = await tx
        .select()
        .from(removalRequests)
        .where(eq(removalRequests.id, filed.removalRequestId));
      expect(row?.rejectionReason).toBeNull();
    });
  });

  it("refuses a viewer who is not an admin and changes nothing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Alex Owner",
        requesterEmail: "alex@example.co.uk",
        relationship: "owner",
        reason: null,
        ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      expect((await actionRemovalRequest(tx, USER, filed.removalRequestId, { decision: "actioned", ip: null })).outcome)
        .toBe("forbidden");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.status).toBe("published");
      expect(await tx.select().from(suppressions)).toHaveLength(0);
      expect(await tx.select().from(jobQueue)).toHaveLength(0);
    });
  });

  it("will not action the same request twice", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn", postcode: "LS1 4AP" });
      const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Alex Owner",
        requesterEmail: "alex@example.co.uk",
        relationship: "owner",
        reason: null,
        ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      await actionRemovalRequest(tx, admin, filed.removalRequestId, { decision: "actioned", ip: null });
      const again = await actionRemovalRequest(tx, admin, filed.removalRequestId, { decision: "actioned", ip: null });
      expect(again.outcome).toBe("not-open");
      // One decision, one suppression. A double click must not file two.
      expect(await tx.select().from(suppressions)).toHaveLength(1);
      // ...and one notification job, not one per attempt.
      expect(await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_REMOVAL_ACTIONED)))
        .toHaveLength(1);
    });
  });
});

describe("the notification read models", () => {
  it("refuse anyone but the worker", async () => {
    await withTestDb(async (tx) => {
      await expect(reportNotification(tx, PUBLIC_VIEWER, randomUUID())).rejects.toThrow(/FORBIDDEN/);
      await expect(removalNotification(tx, USER, randomUUID())).rejects.toThrow(/FORBIDDEN/);
    });
  });

  it("give the report notification everything the email needs", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });
      const filed = await createReport(tx, PUBLIC_VIEWER, {
        listingId,
        reason: "closed",
        detail: "Shut in March.",
        reporterEmail: "spotter@example.co.uk",
        ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      const data = await reportNotification(tx, admin, filed.reportId);
      expect(data).toMatchObject({
        listingName: "The Old Mill",
        reason: "closed",
        detail: "Shut in March.",
        reporterEmail: "spotter@example.co.uk",
      });
      expect(data?.listingPath).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);
    });
  });

  it("give the removal notification the requester and the deadline", async () => {
    setClock(new Date("2026-06-12T10:00:00Z"));
    try {
      await withTestDb(async (tx) => {
        const admin = await makeAdmin(tx);
        const ctx = await makeScaffold(tx);
        const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });
        const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
          listingId,
          requesterName: "Alex Owner",
          requesterEmail: "alex@example.co.uk",
          relationship: "subject",
          reason: null,
          ip: null,
        });
        if (filed.outcome !== "created") throw new Error("setup failed");

        const data = await removalNotification(tx, admin, filed.removalRequestId);
        expect(data).toMatchObject({
          listingName: "The Old Mill",
          requesterName: "Alex Owner",
          requesterEmail: "alex@example.co.uk",
          relationship: "subject",
          reason: null,
        });
        expect(data?.dueAt.toISOString()).toBe("2026-06-19T10:00:00.000Z");
      });
    } finally {
      resetClock();
    }
  });

  it("report nothing for a row that is not there", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      expect(await reportNotification(tx, admin, randomUUID())).toBeNull();
      expect(await removalNotification(tx, admin, randomUUID())).toBeNull();
    });
  });

  it("give the removal decision notification the requester, after the request is closed", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Alex Owner",
        requesterEmail: "alex@example.co.uk",
        relationship: "owner",
        reason: null,
        ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      await actionRemovalRequest(tx, admin, filed.removalRequestId, { decision: "actioned", ip: null });

      const data = await removalDecisionNotification(tx, admin, filed.removalRequestId);
      expect(data).toMatchObject({
        listingName: "The Old Barn",
        requesterName: "Alex Owner",
        requesterEmail: "alex@example.co.uk",
      });
    });
  });

  it("give the removal decision notification the reason a request was turned down", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
        listingId,
        requesterName: "Someone Else",
        requesterEmail: "someone@example.co.uk",
        relationship: "other",
        reason: null,
        ip: null,
      });
      if (filed.outcome !== "created") throw new Error("setup failed");

      await actionRemovalRequest(tx, admin, filed.removalRequestId, {
        decision: "rejected",
        reason: "The request came from somebody with no connection to the entry.",
        ip: null,
      });

      const data = await removalDecisionNotification(tx, admin, filed.removalRequestId);
      expect(data).toMatchObject({
        listingName: "The Old Barn",
        requesterEmail: "someone@example.co.uk",
        rejectionReason: "The request came from somebody with no connection to the entry.",
      });
    });
  });

  it("refuses a non-admin and is nothing for a row that is not there", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAdmin(tx);
      await expect(removalDecisionNotification(tx, USER, randomUUID())).rejects.toThrow(/FORBIDDEN/);
      expect(await removalDecisionNotification(tx, admin, randomUUID())).toBeNull();
    });
  });
});

describe("trustTarget", () => {
  it("names the listing the two forms are about", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });

      const target = await trustTarget(tx, PUBLIC_VIEWER, listingId);
      expect(target).toMatchObject({ id: listingId, name: "The Old Mill" });
      expect(target?.path).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);
    });
  });

  it("is nothing for a listing the public cannot see, or an id that is not one", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const hidden = await makeListing(tx, ctx, { status: "removed" });

      expect(await trustTarget(tx, PUBLIC_VIEWER, hidden)).toBeNull();
      expect(await trustTarget(tx, PUBLIC_VIEWER, randomUUID())).toBeNull();
      expect(await trustTarget(tx, PUBLIC_VIEWER, "not-a-uuid")).toBeNull();
    });
  });
});
