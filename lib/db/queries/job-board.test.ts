import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { auditLog, jobQueue, jobs } from "@/lib/db/schema";
import { makeCategoryInCity, makeCity, makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { makeViewer } from "@/test/admin-fixtures";
import { ensureProfile } from "@/lib/auth/profile";
import { now, resetClock, setClock } from "@/lib/clock";
import { siteConfig } from "@/config/site.config";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { NOTIFY_JOB_DECIDED, NOTIFY_JOB_SUBMITTED } from "@/lib/email/notify-jobs";
import {
  JOBS_PER_PAGE,
  approveJob,
  attachJobOrder,
  countOpenJobs,
  countPendingJobs,
  createJob,
  expireDueJobs,
  getPublicJob,
  jobFilterOptions,
  jobForOrder,
  jobNotifyContext,
  jobPaths,
  jobsDueReminder,
  listOpenJobs,
  markJobPaid,
  markJobReminderSent,
  pendingJobs,
  posterListings,
  recordJobApply,
  rejectJob,
  resolveJobFilters,
  type CreateJobInput,
} from "./job-board";

const ADMIN: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };
const DAY = 86_400_000;

afterEach(() => resetClock());

function input(ctx: ListingCtx, patch: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    title: "Weekend coordinator",
    description: "Someone to run the Saturday diary and keep the suppliers in step.",
    companyName: "The Old Mill",
    posterName: "Sam Owner",
    posterEmail: "sam@example.co.uk",
    cityId: ctx.cityId,
    categoryId: ctx.primaryCategoryId,
    budgetMin: null,
    budgetMax: null,
    applyMethod: "email",
    applyEmail: "jobs@example.co.uk",
    applyUrl: null,
    listingId: null,
    posterProfileId: null,
    ip: "203.0.113.5",
    ...patch,
  };
}

/** A job straight in the table, in whatever state the test needs. */
async function makeJob(
  tx: TestDb,
  ctx: ListingCtx,
  patch: Partial<typeof jobs.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await tx.insert(jobs).values({
    id,
    title: patch.title ?? `Job ${id.slice(0, 8)}`,
    description: "A description.",
    companyName: "Acme",
    cityId: ctx.cityId,
    categoryId: ctx.primaryCategoryId,
    posterEmail: "poster@example.co.uk",
    applyMethod: "email",
    applyEmail: "poster@example.co.uk",
    status: "published",
    paymentStatus: "free",
    publishedAt: now(),
    expiresAt: new Date(now().getTime() + 30 * DAY),
    ...patch,
  });
  return id;
}

async function readJob(tx: TestDb, id: string) {
  const [row] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row;
}

async function signedIn(tx: TestDb) {
  const viewer = await makeViewer(tx, "user");
  const profile = await ensureProfile(tx, viewer);
  return { viewer, profileId: profile.id };
}

describe("listOpenJobs / countOpenJobs", () => {
  it("lists published, unexpired jobs newest first and hides the rest", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const older = await makeJob(tx, ctx, { title: "Older", publishedAt: new Date("2026-09-01T00:00:00Z") });
      const newer = await makeJob(tx, ctx, { title: "Newer", publishedAt: new Date("2026-09-20T00:00:00Z") });
      await makeJob(tx, ctx, { title: "Pending", status: "pending" });
      await makeJob(tx, ctx, { title: "Removed", status: "removed" });
      await makeJob(tx, ctx, { title: "Expired", status: "expired" });
      await makeJob(tx, ctx, { title: "Past", expiresAt: new Date("2026-09-21T00:00:00Z") });

      const rows = await listOpenJobs(tx, PUBLIC_VIEWER, { page: 1 });
      expect(rows.map((r) => r.id)).toEqual([newer, older]);
      expect(rows[0]?.path).toBe(`/jobs/${newer}`);
      expect(rows[0]?.cityName).toBe("Leeds");
      expect(await countOpenJobs(tx, PUBLIC_VIEWER, {})).toBe(2);
    });
  });

  it("shows an admin exactly what the public sees — the list is a cached page", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeJob(tx, ctx, { status: "pending" });
      expect(await countOpenJobs(tx, ADMIN, {})).toBe(0);
    });
  });

  it("filters by town and by category, together or apart", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const otherCity = await makeCity(tx, "York", "North Yorkshire");
      const otherCategory = await makeCategoryInCity(tx, ctx.verticalId, ctx.cityId, "Hotel Venues");
      const a = await makeJob(tx, ctx);
      const b = await makeJob(tx, ctx, { cityId: otherCity });
      const c = await makeJob(tx, ctx, { categoryId: otherCategory });

      const ids = async (f: { citySlug?: string; categorySlug?: string }) =>
        (await listOpenJobs(tx, PUBLIC_VIEWER, { page: 1, ...f })).map((r) => r.id).sort();

      expect(await ids({ citySlug: "york" })).toEqual([b]);
      expect(await ids({ categorySlug: "hotel-venues" })).toEqual([c]);
      expect(await ids({ citySlug: "leeds", categorySlug: "barn-venues" })).toEqual([a]);
      expect(await countOpenJobs(tx, PUBLIC_VIEWER, { citySlug: "leeds" })).toBe(2);
    });
  });

  it("paginates by JOBS_PER_PAGE", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      for (let n = 0; n < JOBS_PER_PAGE + 1; n++) {
        await makeJob(tx, ctx, { publishedAt: new Date(Date.UTC(2026, 0, 1 + n)) });
      }
      expect(await listOpenJobs(tx, PUBLIC_VIEWER, { page: 1 })).toHaveLength(JOBS_PER_PAGE);
      expect(await listOpenJobs(tx, PUBLIC_VIEWER, { page: 2 })).toHaveLength(1);
      expect(await listOpenJobs(tx, PUBLIC_VIEWER, { page: 3 })).toHaveLength(0);
    });
  });
});

describe("listOpenJobs / countOpenJobs — createdAfter (saved-search alerts)", () => {
  it("keeps only open jobs created strictly after the instant, and carries createdAt on the card", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const since = new Date("2026-09-20T12:00:00Z");
      await makeJob(tx, ctx, { title: "Before", createdAt: new Date("2026-09-19T12:00:00Z") });
      const after = await makeJob(tx, ctx, { title: "After", createdAt: new Date("2026-09-21T12:00:00Z") });
      await makeJob(tx, ctx, { title: "After but pending", status: "pending", createdAt: new Date("2026-09-21T12:00:00Z") });

      const rows = await listOpenJobs(tx, PUBLIC_VIEWER, { page: 1, createdAfter: since });
      expect(rows.map((r) => r.id)).toEqual([after]);
      expect(rows[0]?.createdAt).toEqual(new Date("2026-09-21T12:00:00Z"));
      expect(await countOpenJobs(tx, PUBLIC_VIEWER, { createdAfter: since })).toBe(1);
      expect(await countOpenJobs(tx, PUBLIC_VIEWER, {})).toBe(2);
    });
  });
});

describe("filters", () => {
  it("offers only towns and categories that have an open job, with counts", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const quiet = await makeCity(tx, "York", "North Yorkshire");
      await makeJob(tx, ctx);
      await makeJob(tx, ctx);
      await makeJob(tx, ctx, { cityId: quiet, status: "pending" });

      const options = await jobFilterOptions(tx, PUBLIC_VIEWER);
      expect(options.cities).toEqual([{ name: "Leeds", slug: "leeds", count: 2 }]);
      expect(options.categories).toEqual([{ name: "Barn Venues", slug: "barn-venues", count: 2 }]);
    });
  });

  it("resolves filter slugs to names and refuses one that does not exist", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeJob(tx, ctx);
      const both = await resolveJobFilters(tx, PUBLIC_VIEWER, { citySlug: "leeds", categorySlug: "barn-venues" });
      expect(both).toEqual({ city: { name: "Leeds", slug: "leeds" }, category: { name: "Barn Venues", slug: "barn-venues" } });
      expect(await resolveJobFilters(tx, PUBLIC_VIEWER, { citySlug: "nowhere" })).toBeNull();
      expect(await resolveJobFilters(tx, PUBLIC_VIEWER, {})).toEqual({ city: null, category: null });
    });
  });
});

describe("getPublicJob", () => {
  it("returns a published job as open and an expired one as closed", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const open = await makeJob(tx, ctx);
      const closed = await makeJob(tx, ctx, { status: "expired" });
      const lapsed = await makeJob(tx, ctx, { expiresAt: new Date(now().getTime() - DAY) });

      expect((await getPublicJob(tx, PUBLIC_VIEWER, open))?.open).toBe(true);
      expect((await getPublicJob(tx, PUBLIC_VIEWER, closed))?.open).toBe(false);
      expect((await getPublicJob(tx, PUBLIC_VIEWER, lapsed))?.open).toBe(false);
    });
  });

  it("hides pending and removed jobs from everyone, and shrugs at a non-uuid", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const pending = await makeJob(tx, ctx, { status: "pending" });
      const removed = await makeJob(tx, ctx, { status: "removed" });
      expect(await getPublicJob(tx, PUBLIC_VIEWER, pending)).toBeNull();
      expect(await getPublicJob(tx, ADMIN, pending)).toBeNull();
      expect(await getPublicJob(tx, PUBLIC_VIEWER, removed)).toBeNull();
      expect(await getPublicJob(tx, PUBLIC_VIEWER, "not-a-uuid")).toBeNull();
    });
  });
});

describe("createJob", () => {
  it("files a pending post that owes a payment when nobody verified is behind it", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const result = await createJob(tx, PUBLIC_VIEWER, input(ctx));
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      expect(result.free).toBe(false);
      const row = await readJob(tx, result.jobId);
      expect(row?.status).toBe("pending");
      expect(row?.paymentStatus).toBe("pending");
      expect(row?.publishedAt).toBeNull();
      expect(row?.expiresAt).toBeNull();
      expect(row?.ip).toBe("203.0.113.5");
      // Nothing is told about a post that has not been paid for yet.
      const queued = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_JOB_SUBMITTED));
      expect(queued.filter((q) => (q.payload as { jobId: string }).jobId === result.jobId)).toHaveLength(0);
    });
  });

  it("posts free, linked to the listing, for the owner of a Verified listing — and tells the admin", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { viewer, profileId } = await signedIn(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: profileId, claimStatus: "verified" });
      const result = await createJob(tx, viewer, input(ctx, { listingId, posterProfileId: profileId }));
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      expect(result.free).toBe(true);
      const row = await readJob(tx, result.jobId);
      expect(row?.paymentStatus).toBe("free");
      expect(row?.listingId).toBe(listingId);
      expect(row?.posterProfileId).toBe(profileId);
      const queued = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_JOB_SUBMITTED));
      expect(queued.filter((q) => (q.payload as { jobId: string }).jobId === result.jobId)).toHaveLength(1);
    });
  });

  it("refuses a free post on a listing that is claimed but not Verified, or somebody else's", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { viewer, profileId } = await signedIn(tx);
      const other = await signedIn(tx);
      const claimed = await makeListing(tx, ctx, { ownerId: profileId, claimStatus: "claimed" });
      const theirs = await makeListing(tx, ctx, { ownerId: other.profileId, claimStatus: "verified" });
      expect((await createJob(tx, viewer, input(ctx, { listingId: claimed, posterProfileId: profileId }))).outcome)
        .toBe("not-verified-listing");
      expect((await createJob(tx, viewer, input(ctx, { listingId: theirs, posterProfileId: profileId }))).outcome)
        .toBe("not-verified-listing");
      // A stranger cannot name a listing at all.
      expect((await createJob(tx, PUBLIC_VIEWER, input(ctx, { listingId: theirs }))).outcome)
        .toBe("not-verified-listing");
    });
  });

  it("treats a lapsed verification as not Verified, in the free-post check and the picker alike", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const { viewer, profileId } = await signedIn(tx);
      const lapsed = await makeListing(tx, ctx, { ownerId: profileId, claimStatus: "verified", verifiedExpiresAt: new Date("2026-09-01T00:00:00Z") });
      const live = await makeListing(tx, ctx, { ownerId: profileId, claimStatus: "verified", verifiedExpiresAt: new Date("2027-09-01T00:00:00Z") });
      expect((await createJob(tx, viewer, input(ctx, { listingId: lapsed, posterProfileId: profileId }))).outcome).toBe("not-verified-listing");
      expect((await createJob(tx, viewer, input(ctx, { listingId: live, posterProfileId: profileId }))).outcome).toBe("created");
      const rows = await posterListings(tx, viewer, profileId);
      expect(rows.find((r) => r.id === lapsed)?.verified).toBe(false);
      expect(rows.find((r) => r.id === live)?.verified).toBe(true);
    });
  });

  it("refuses a town or category it does not hold", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      expect((await createJob(tx, PUBLIC_VIEWER, input(ctx, { cityId: randomUUID() }))).outcome).toBe("unknown-city");
      expect((await createJob(tx, PUBLIC_VIEWER, input(ctx, { categoryId: randomUUID() }))).outcome).toBe("unknown-category");
      expect((await createJob(tx, PUBLIC_VIEWER, input(ctx, { categoryId: "nope" }))).outcome).toBe("unknown-category");
    });
  });
});

describe("posterListings", () => {
  it("returns the signed-in owner's published listings with their Verified state, nobody else's", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { viewer, profileId } = await signedIn(tx);
      const other = await signedIn(tx);
      const verified = await makeListing(tx, ctx, { ownerId: profileId, claimStatus: "verified", name: "Mine V" });
      const claimed = await makeListing(tx, ctx, { ownerId: profileId, claimStatus: "claimed", name: "Mine C" });
      await makeListing(tx, ctx, { ownerId: profileId, claimStatus: "verified", status: "draft" });
      await makeListing(tx, ctx, { ownerId: other.profileId, claimStatus: "verified" });

      const rows = await posterListings(tx, viewer, profileId);
      expect(rows.map((r) => [r.id, r.verified]).sort()).toEqual([[claimed, false], [verified, true]].sort());
      expect(rows.find((r) => r.id === verified)?.path).toBe("/leeds/mine-v");
    });
  });

  it("throws for the public", async () => {
    await withTestDb(async (tx) => {
      await expect(posterListings(tx, PUBLIC_VIEWER, randomUUID())).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("payment", () => {
  it("attaches the order, finds the job by it, and marks it paid exactly once", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const created = await createJob(tx, PUBLIC_VIEWER, input(ctx));
      if (created.outcome !== "created") throw new Error("setup");
      await attachJobOrder(tx, PUBLIC_VIEWER, { jobId: created.jobId, providerOrderId: "5O190127TN364715T" });

      expect(await jobForOrder(tx, ADMIN, "5O190127TN364715T")).toMatchObject({ id: created.jobId, paymentStatus: "pending" });
      expect(await jobForOrder(tx, ADMIN, "nope")).toBeNull();

      const first = await markJobPaid(tx, ADMIN, { providerOrderId: "5O190127TN364715T", captureId: "CAP-1", eventId: "WH-1" });
      expect(first).toEqual({ outcome: "paid", jobId: created.jobId });
      const row = await readJob(tx, created.jobId);
      expect(row?.paymentStatus).toBe("paid");
      expect(row?.providerCaptureId).toBe("CAP-1");
      expect(row?.paidAt).not.toBeNull();
      // Paid and pending: the admin queue is now told.
      const queued = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_JOB_SUBMITTED));
      expect(queued.filter((q) => (q.payload as { jobId: string }).jobId === created.jobId)).toHaveLength(1);

      const again = await markJobPaid(tx, ADMIN, { providerOrderId: "5O190127TN364715T", captureId: "CAP-1", eventId: "WH-2" });
      expect(again).toEqual({ outcome: "already-paid", jobId: created.jobId });
      expect(await markJobPaid(tx, ADMIN, { providerOrderId: "missing", captureId: "x", eventId: "WH-3" }))
        .toEqual({ outcome: "unknown-order" });

      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, created.jobId), eq(auditLog.action, "job.paid")));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actorId).toBeNull();
    });
  });

  it("a capture landing on a row that is no longer pending grants nothing and is written down for a refund", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const removed = await makeJob(tx, ctx, { status: "removed", paymentStatus: "pending", providerOrderId: "LATE-1", publishedAt: null, expiresAt: null });
      const out = await markJobPaid(tx, ADMIN, { providerOrderId: "LATE-1", captureId: "CAP-L", eventId: "WH-L" });
      expect(out).toEqual({ outcome: "not-pending", jobId: removed, status: "removed" });
      expect((await readJob(tx, removed))?.paymentStatus).toBe("pending");
      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, removed));
      expect(audits.map((a) => a.action)).toEqual(["job.paid.late"]);
      expect((audits[0]?.meta as { refundNeeded: boolean }).refundNeeded).toBe(true);
      const queued = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_JOB_SUBMITTED));
      expect(queued.filter((q) => (q.payload as { jobId: string }).jobId === removed)).toHaveLength(0);
    });
  });

  it("refuses to settle when the event names a different job from the order's", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const job = await makeJob(tx, ctx, { status: "pending", paymentStatus: "pending", providerOrderId: "X-1", publishedAt: null, expiresAt: null });
      const out = await markJobPaid(tx, ADMIN, { providerOrderId: "X-1", captureId: "c", eventId: "e", expectedJobId: randomUUID() });
      expect(out).toEqual({ outcome: "job-mismatch", jobId: job });
      expect((await readJob(tx, job))?.paymentStatus).toBe("pending");
      expect(await markJobPaid(tx, ADMIN, { providerOrderId: "X-1", captureId: "c", eventId: "e", expectedJobId: job })).toEqual({ outcome: "paid", jobId: job });
    });
  });

  it("only the worker may read or settle payments", async () => {
    await withTestDb(async (tx) => {
      await expect(jobForOrder(tx, PUBLIC_VIEWER, "x")).rejects.toThrow("FORBIDDEN");
      await expect(markJobPaid(tx, { role: "user", userId: "u" }, { providerOrderId: "x", captureId: "c", eventId: "e" }))
        .rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("admin queue and decisions", () => {
  it("queues only posts that are pending AND paid for (or free)", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const admin = await makeViewer(tx, "admin");
      const free = await makeJob(tx, ctx, { status: "pending", paymentStatus: "free", publishedAt: null, expiresAt: null });
      const paid = await makeJob(tx, ctx, { status: "pending", paymentStatus: "paid", publishedAt: null, expiresAt: null });
      await makeJob(tx, ctx, { status: "pending", paymentStatus: "pending", publishedAt: null, expiresAt: null });
      await makeJob(tx, ctx);

      const queue = await pendingJobs(tx, admin);
      expect(queue.map((j) => j.id).sort()).toEqual([free, paid].sort());
      expect(await countPendingJobs(tx, admin)).toBe(2);
      await expect(pendingJobs(tx, PUBLIC_VIEWER)).rejects.toThrow("FORBIDDEN");
      await expect(pendingJobs(tx, { role: "owner", userId: "o" })).rejects.toThrow("FORBIDDEN");
    });
  });

  it("approval publishes for durationDays, stamps datePosted, audits with ip and tells the poster", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const admin = await makeViewer(tx, "admin");
      const id = await makeJob(tx, ctx, { status: "pending", publishedAt: null, expiresAt: null });

      const result = await approveJob(tx, admin, id, { ip: "198.51.100.7" });
      expect(result).toEqual({ outcome: "approved", jobId: id });
      const row = await readJob(tx, id);
      expect(row?.status).toBe("published");
      expect(row?.publishedAt?.toISOString()).toBe("2026-09-22T10:00:00.000Z");
      expect(row?.expiresAt?.getTime()).toBe(now().getTime() + siteConfig.jobs.durationDays * DAY);

      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "job.approved")));
      expect(audit?.ip).toBe("198.51.100.7");
      expect(audit?.actorId).not.toBeNull();
      expect(audit?.entityType).toBe("job");
      const queued = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_JOB_DECIDED));
      expect(queued.filter((q) => (q.payload as { jobId: string }).jobId === id)).toHaveLength(1);

      expect(await approveJob(tx, admin, id, { ip: null })).toEqual({ outcome: "not-pending", status: "published" });
      expect(await approveJob(tx, admin, randomUUID(), { ip: null })).toEqual({ outcome: "unknown-job" });
    });
  });

  it("refuses to approve a post that has not been paid for", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const admin = await makeViewer(tx, "admin");
      const id = await makeJob(tx, ctx, { status: "pending", paymentStatus: "pending", publishedAt: null, expiresAt: null });
      expect(await approveJob(tx, admin, id, { ip: null })).toEqual({ outcome: "unpaid" });
      expect((await readJob(tx, id))?.status).toBe("pending");
    });
  });

  it("refuses to reject a post that has not been paid for — it was never in the queue", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const admin = await makeViewer(tx, "admin");
      const id = await makeJob(tx, ctx, { status: "pending", paymentStatus: "pending", publishedAt: null, expiresAt: null });
      expect(await rejectJob(tx, admin, id, { ip: null, reason: "Spam." })).toEqual({ outcome: "unpaid" });
      expect((await readJob(tx, id))?.status).toBe("pending");
    });
  });

  it("rejection removes the post with a reason and audits", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const admin = await makeViewer(tx, "admin");
      const id = await makeJob(tx, ctx, { status: "pending", publishedAt: null, expiresAt: null });

      expect(await rejectJob(tx, admin, id, { ip: null, reason: "   " })).toEqual({ outcome: "reason-required" });
      const result = await rejectJob(tx, admin, id, { ip: null, reason: "Not a real vacancy." });
      expect(result).toEqual({ outcome: "rejected", jobId: id });
      const row = await readJob(tx, id);
      expect(row?.status).toBe("removed");
      expect(row?.rejectedReason).toBe("Not a real vacancy.");
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "job.rejected")));
      expect(audits).toHaveLength(1);
    });
  });

  it("decisions are admin-only", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeJob(tx, ctx, { status: "pending" });
      await expect(approveJob(tx, PUBLIC_VIEWER, id, { ip: null })).rejects.toThrow("FORBIDDEN");
      await expect(rejectJob(tx, { role: "owner", userId: "o" }, id, { ip: null, reason: "x" })).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("expiry and reminders", () => {
  it("expires published jobs whose date has passed, by the clock, once", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const due = await makeJob(tx, ctx, { expiresAt: new Date("2026-09-22T09:59:00Z") });
      const later = await makeJob(tx, ctx, { expiresAt: new Date("2026-09-23T00:00:00Z") });
      await makeJob(tx, ctx, { status: "pending", expiresAt: new Date("2026-09-01T00:00:00Z") });

      expect(await expireDueJobs(tx, ADMIN)).toEqual([due]);
      expect((await readJob(tx, due))?.status).toBe("expired");
      expect((await readJob(tx, later))?.status).toBe("published");
      expect(await expireDueJobs(tx, ADMIN)).toEqual([]);
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, due), eq(auditLog.action, "job.expired")));
      expect(audits).toHaveLength(1);
      await expect(expireDueJobs(tx, PUBLIC_VIEWER)).rejects.toThrow("FORBIDDEN");
    });
  });

  it("finds jobs inside the reminder window that have not been reminded, and marks them", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const days = siteConfig.jobs.reminderDays;
      const inside = await makeJob(tx, ctx, { expiresAt: new Date(now().getTime() + (days - 1) * DAY) });
      const edge = await makeJob(tx, ctx, { expiresAt: new Date(now().getTime() + days * DAY) });
      await makeJob(tx, ctx, { expiresAt: new Date(now().getTime() + (days + 1) * DAY) });
      await makeJob(tx, ctx, { expiresAt: new Date(now().getTime() + DAY), reminderSentAt: now() });
      await makeJob(tx, ctx, { expiresAt: new Date(now().getTime() - DAY) });

      const due = await jobsDueReminder(tx, ADMIN);
      expect(due.map((j) => j.id).sort()).toEqual([inside, edge].sort());

      expect(await markJobReminderSent(tx, ADMIN, inside)).toBe(true);
      expect(await markJobReminderSent(tx, ADMIN, inside)).toBe(false);
      expect((await jobsDueReminder(tx, ADMIN)).map((j) => j.id)).toEqual([edge]);
    });
  });

  it("gives the worker what the emails need", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeJob(tx, ctx, { title: "Florist", posterName: "Pat", status: "removed", rejectedReason: "Spam" });
      const context = await jobNotifyContext(tx, ADMIN, id);
      expect(context).toMatchObject({ id, title: "Florist", posterName: "Pat", posterEmail: "poster@example.co.uk", status: "removed", rejectedReason: "Spam", path: `/jobs/${id}` });
      expect(await jobNotifyContext(tx, ADMIN, randomUUID())).toBeNull();
      await expect(jobNotifyContext(tx, PUBLIC_VIEWER, id)).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("recordJobApply", () => {
  it("counts a press on an open job and ignores one on anything else", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const open = await makeJob(tx, ctx);
      const closed = await makeJob(tx, ctx, { status: "expired" });
      expect(await recordJobApply(tx, PUBLIC_VIEWER, open)).toBe(true);
      expect(await recordJobApply(tx, PUBLIC_VIEWER, open)).toBe(true);
      expect(await recordJobApply(tx, PUBLIC_VIEWER, closed)).toBe(false);
      expect(await recordJobApply(tx, PUBLIC_VIEWER, "junk")).toBe(false);
      expect((await readJob(tx, open))?.applyCount).toBe(2);
    });
  });
});

describe("jobPaths", () => {
  it("names the board, the job and its filter pages", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeJob(tx, ctx);
      expect(await jobPaths(tx, ADMIN, id)).toEqual([
        "/jobs",
        `/jobs/${id}`,
        "/jobs/in/leeds",
        "/jobs/in/leeds/barn-venues",
        "/jobs/category/barn-venues",
      ]);
      expect(await jobPaths(tx, ADMIN, randomUUID())).toEqual(["/jobs"]);
    });
  });
});
