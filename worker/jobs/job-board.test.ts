import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { jobQueue, jobs } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeScaffold, type ListingCtx } from "@/test/factories";
import { now, resetClock, setClock } from "@/lib/clock";
import { siteConfig } from "@/config/site.config";
import { JOB_BOARD_NOTIFY_KINDS, NOTIFY_JOB_EXPIRING, notifyJobDecided, notifyJobSubmitted } from "@/lib/email/notify-jobs";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { drainJobBoardNotifications, enqueueExpiryReminders, expireJobs, runJobBoard } from "./job-board";

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    sent.push({ to: message.to, subject: message.subject, text: message.text });
    return { sent: true, id: `m-${sent.length}` };
  },
}));

const ENV = { ...process.env };
const DAY = 86_400_000;

beforeEach(() => {
  sent.length = 0;
  process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.co.uk";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";
});
afterEach(() => {
  process.env = { ...ENV };
  resetClock();
});

async function makeJob(tx: TestDb, ctx: ListingCtx, patch: Partial<typeof jobs.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  await tx.insert(jobs).values({
    id,
    title: "Weekend coordinator",
    companyName: "Acme",
    cityId: ctx.cityId,
    categoryId: ctx.primaryCategoryId,
    posterName: "Pat",
    posterEmail: "pat@example.co.uk",
    status: "published",
    paymentStatus: "free",
    publishedAt: now(),
    expiresAt: new Date(now().getTime() + 30 * DAY),
    ...patch,
  });
  return id;
}

async function status(tx: TestDb, id: string) {
  const [row] = await tx.select({ s: jobs.status, r: jobs.reminderSentAt }).from(jobs).where(eq(jobs.id, id)).limit(1);
  return row;
}

describe("expireJobs", () => {
  it("closes what is due and names the pages to bust", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const due = await makeJob(tx, ctx, { expiresAt: new Date("2026-09-22T09:00:00Z") });
      const out = await expireJobs(tx as never);
      expect(out.expired).toEqual([due]);
      expect(out.paths).toContain("/jobs");
      expect(out.paths).toContain(`/jobs/${due}`);
      expect((await status(tx, due))?.s).toBe("expired");
    });
  });
});

describe("expiry reminders", () => {
  it("queues one reminder per job inside the window, marks it, and never repeats", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const soon = await makeJob(tx, ctx, { expiresAt: new Date(now().getTime() + (siteConfig.jobs.reminderDays - 1) * DAY) });
      await makeJob(tx, ctx);

      expect(await enqueueExpiryReminders(tx as never)).toBe(1);
      expect(await enqueueExpiryReminders(tx as never)).toBe(0);
      expect((await status(tx, soon))?.r).not.toBeNull();
      const queued = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_JOB_EXPIRING));
      expect(queued.filter((q) => (q.payload as { jobId: string }).jobId === soon)).toHaveLength(1);

      expect(await drainJobBoardNotifications(tx as never)).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe("pat@example.co.uk");
      expect(sent[0]?.subject).toContain("closes on");
      expect(sent[0]?.text).toContain("https://example.co.uk/post-a-job");
    });
  });
});

describe("drainJobBoardNotifications", () => {
  it("tells the admin about a waiting post and says whether it was paid", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const paid = await makeJob(tx, ctx, { status: "pending", paymentStatus: "paid", publishedAt: null, expiresAt: null });
      await notifyJobSubmitted(tx, ADMIN_VIEWER, paid);
      await drainJobBoardNotifications(tx as never);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe("admin@example.co.uk");
      expect(sent[0]?.text).toContain("has paid");
      expect(sent[0]?.text).toContain("https://example.co.uk/admin/jobs");
    });
  });

  it("sends the approval or the rejection by re-reading the row, and nothing for a post still pending", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const live = await makeJob(tx, ctx);
      const gone = await makeJob(tx, ctx, { status: "removed", rejectedReason: "Not a vacancy." });
      const undecided = await makeJob(tx, ctx, { status: "pending" });
      for (const id of [live, gone, undecided]) await notifyJobDecided(tx, ADMIN_VIEWER, id);

      expect(await drainJobBoardNotifications(tx as never)).toBe(3);
      expect(sent.map((m) => m.subject)).toEqual([
        expect.stringContaining("is live"),
        expect.stringContaining("About your job post"),
      ]);
      expect(sent[1]?.text).toContain("Not a vacancy.");
    });
  });

  it("completes rather than retries when there is nobody to write to, and drains only its own kinds", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const anonymous = await makeJob(tx, ctx, { posterEmail: null });
      await notifyJobDecided(tx, ADMIN_VIEWER, anonymous);
      const { enqueueJob } = await import("@/lib/db/queries/jobs");
      const foreign = await enqueueJob(tx, ADMIN_VIEWER, { kind: "notify.enquiry", payload: {} });

      expect(await drainJobBoardNotifications(tx as never)).toBe(1);
      expect(sent).toHaveLength(0);
      const [row] = await tx.select({ status: jobQueue.status }).from(jobQueue).where(eq(jobQueue.id, foreign));
      expect(row?.status).toBe("pending");
      expect(new Set(JOB_BOARD_NOTIFY_KINDS).size).toBe(JOB_BOARD_NOTIFY_KINDS.length);
    });
  });

  it("runJobBoard hands back the expired pages for revalidation", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const due = await makeJob(tx, ctx, { expiresAt: new Date("2026-09-22T09:00:00Z") });
      const out = await runJobBoard(tx as never);
      expect(out.revalidate).toContain(`/jobs/${due}`);
    });
  });
});
