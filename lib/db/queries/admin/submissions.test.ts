import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { auditLog, cities, jobQueue, listings } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { makeViewer } from "@/test/admin-fixtures";
import { makeScaffold, makeListing, type ListingCtx } from "@/test/factories";
import { NOTIFY_DECISION } from "@/lib/email/notify";
import {
  SUBMISSIONS_PER_PAGE,
  approveSubmission,
  pendingSubmissions,
  rejectSubmission,
  submissionDetail,
} from "./submissions";

async function makePending(
  tx: TestDb,
  ctx: ListingCtx,
  patch: Partial<typeof listings.$inferInsert> = {},
): Promise<string> {
  return makeListing(tx, ctx, {
    status: "pending",
    source: "public",
    submittedByEmail: "sam@example.co.uk",
    phone: "01632 960111",
    postcode: "LS1 4DY",
    addressLine1: "1 Mill Lane",
    description: "A description long enough to be worth reading in the queue.",
    customFields: {
      submission: {
        submitterName: "Sam Owner",
        submitterEmail: "sam@example.co.uk",
        requestedTier: "premium",
        submittedCity: "Leeds",
        submittedRegion: "West Yorkshire",
      },
    },
    ...patch,
  });
}

async function readListing(tx: TestDb, id: string) {
  const [row] = await tx.select().from(listings).where(eq(listings.id, id)).limit(1);
  return row;
}

describe("pendingSubmissions", () => {
  it("lists only pending listings, oldest first, with who to write back to", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "Already Live", status: "published" });
      await makeListing(tx, ctx, { name: "Turned Down", status: "rejected" });
      const pendingId = await makePending(tx, ctx, { name: "Waiting Room" });

      const page = await pendingSubmissions(tx, admin, 1);

      expect(page.total).toBe(1);
      expect(page.rows.map((r) => r.id)).toEqual([pendingId]);
      const row = page.rows[0]!;
      expect(row.name).toBe("Waiting Room");
      expect(row.cityName).toBe("Leeds");
      expect(row.categoryName).toBe("Barn Venues");
      expect(row.submitterEmail).toBe("sam@example.co.uk");
      expect(row.requestedTier).toBe("premium");
    });
  });

  it("pages rather than returning the whole queue", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      for (let n = 0; n < SUBMISSIONS_PER_PAGE + 2; n++) {
        await makePending(tx, ctx, { name: `Queued ${n}` });
      }

      const first = await pendingSubmissions(tx, admin, 1);
      expect(first.rows).toHaveLength(SUBMISSIONS_PER_PAGE);
      expect(first.pageCount).toBe(2);

      const second = await pendingSubmissions(tx, admin, 2);
      expect(second.rows).toHaveLength(2);
      expect(second.page).toBe(2);

      const ids = new Set([...first.rows, ...second.rows].map((r) => r.id));
      expect(ids.size).toBe(SUBMISSIONS_PER_PAGE + 2);
    });
  });

  it("refuses anyone who is not an admin", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeViewer(tx, "owner");
      await expect(pendingSubmissions(tx, owner, 1)).rejects.toThrow("FORBIDDEN");
      await expect(pendingSubmissions(tx, PUBLIC_VIEWER, 1)).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("submissionDetail", () => {
  it("returns every field the submitter sent, including what they asked for", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makePending(tx, ctx, { name: "The Old Mill", website: "https://example.co.uk" });

      const detail = await submissionDetail(tx, admin, id);
      expect(detail).not.toBeNull();
      expect(detail?.name).toBe("The Old Mill");
      expect(detail?.addressLine1).toBe("1 Mill Lane");
      expect(detail?.postcode).toBe("LS1 4DY");
      expect(detail?.phone).toBe("01632 960111");
      expect(detail?.website).toBe("https://example.co.uk");
      expect(detail?.description).toContain("long enough");
      expect(detail?.submitterName).toBe("Sam Owner");
      expect(detail?.submitterEmail).toBe("sam@example.co.uk");
      expect(detail?.requestedTier).toBe("premium");
      expect(detail?.submittedCity).toBe("Leeds");
      expect(detail?.submittedRegion).toBe("West Yorkshire");
      expect(detail?.cityName).toBe("Leeds");
      expect(detail?.status).toBe("pending");
    });
  });

  it("is null for an id that is not there", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const detail = await submissionDetail(tx, admin, "11111111-1111-4111-8111-111111111111");
      expect(detail).toBeNull();
    });
  });

  it("refuses anyone who is not an admin", async () => {
    await withTestDb(async (tx) => {
      const user = await makeViewer(tx, "user");
      const ctx = await makeScaffold(tx);
      const id = await makePending(tx, ctx);
      await expect(submissionDetail(tx, user, id)).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("approveSubmission", () => {
  it("publishes, stamps published_at and clears any earlier rejection", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makePending(tx, ctx, { rejectedReason: "an earlier no" });

      const result = await approveSubmission(tx, admin, id, { ip: "203.0.113.7" });
      expect(result.outcome).toBe("approved");

      const row = await readListing(tx, id);
      expect(row?.status).toBe("published");
      expect(row?.publishedAt).not.toBeNull();
      expect(row?.rejectedReason).toBeNull();
    });
  });

  it("recomputes the city's indexing gate in the same transaction", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      await tx.update(cities).set({ introHtml: "<p>About Leeds.</p>" }).where(eq(cities.id, ctx.cityId));
      // Two already live, so approving the third clears the threshold.
      await makeListing(tx, ctx, { name: "Live One" });
      await makeListing(tx, ctx, { name: "Live Two" });
      const id = await makePending(tx, ctx, { name: "Live Three" });

      await approveSubmission(tx, admin, id, { ip: null });

      const [city] = await tx
        .select({ listingCount: cities.listingCount, isIndexable: cities.isIndexable })
        .from(cities)
        .where(eq(cities.id, ctx.cityId))
        .limit(1);
      expect(city?.listingCount).toBe(3);
      expect(city?.isIndexable).toBe(true);
    });
  });

  it("writes an audit row naming the actor and the transition", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makePending(tx, ctx);

      await approveSubmission(tx, admin, id, { ip: "203.0.113.7" });

      const [row] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "submission.approved")))
        .limit(1);
      expect(row).toBeTruthy();
      expect(row?.entityType).toBe("listing");
      expect(row?.actorId).not.toBeNull();
      expect(row?.ip).toBe("203.0.113.7");
      expect(row?.meta).toMatchObject({ from: "pending", to: "published" });
    });
  });

  it("enqueues the decision email rather than sending one", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makePending(tx, ctx);

      await approveSubmission(tx, admin, id, { ip: null });

      const jobs = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_DECISION));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toEqual({ listingId: id, decision: "approved" });
    });
  });

  it("will not re-decide something that has already left the queue", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, { status: "published" });

      const result = await approveSubmission(tx, admin, id, { ip: null });
      expect(result).toEqual({ outcome: "not-pending", status: "published" });
      expect(await tx.select().from(jobQueue)).toHaveLength(0);
    });
  });

  it("reports an id that is not there", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const result = await approveSubmission(tx, admin, "11111111-1111-4111-8111-111111111111", {
        ip: null,
      });
      expect(result).toEqual({ outcome: "unknown-listing" });
    });
  });

  it("refuses anyone who is not an admin, and changes nothing", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeViewer(tx, "owner");
      const ctx = await makeScaffold(tx);
      const id = await makePending(tx, ctx);

      await expect(approveSubmission(tx, owner, id, { ip: null })).rejects.toThrow("FORBIDDEN");
      expect((await readListing(tx, id))?.status).toBe("pending");
      expect(await tx.select().from(auditLog)).toHaveLength(0);
    });
  });
});

describe("rejectSubmission", () => {
  it("records the reason the submitter will be given", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makePending(tx, ctx);

      const result = await rejectSubmission(tx, admin, id, "  Not a real business.  ", { ip: null });
      expect(result.outcome).toBe("rejected");

      const row = await readListing(tx, id);
      expect(row?.status).toBe("rejected");
      expect(row?.rejectedReason).toBe("Not a real business.");
      expect(row?.publishedAt).toBeNull();
    });
  });

  it("insists on a reason", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makePending(tx, ctx);

      const result = await rejectSubmission(tx, admin, id, "   ", { ip: null });
      expect(result).toEqual({ outcome: "reason-required" });
      expect((await readListing(tx, id))?.status).toBe("pending");
      expect(await tx.select().from(auditLog)).toHaveLength(0);
    });
  });

  it("audits the transition and enqueues the decision email", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makePending(tx, ctx);

      await rejectSubmission(tx, admin, id, "Duplicate of an existing entry.", { ip: "203.0.113.8" });

      const [audit] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "submission.rejected")))
        .limit(1);
      expect(audit?.meta).toMatchObject({
        from: "pending",
        to: "rejected",
        reason: "Duplicate of an existing entry.",
      });

      const jobs = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_DECISION));
      expect(jobs[0]?.payload).toEqual({ listingId: id, decision: "rejected" });
    });
  });

  it("refuses anyone who is not an admin", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makePending(tx, ctx);
      const viewer: Viewer = PUBLIC_VIEWER;
      await expect(rejectSubmission(tx, viewer, id, "no", { ip: null })).rejects.toThrow("FORBIDDEN");
    });
  });
});
