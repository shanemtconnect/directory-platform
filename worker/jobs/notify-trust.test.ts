import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import { jobQueue, removalRequests, reports, user } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { makeScaffold, makeListing } from "@/test/factories";
import { actionRemovalRequest, createRemovalRequest, createReport } from "@/lib/db/queries/trust";
import type { SendResult } from "@/lib/email/sender";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();

vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { notifyRemoval, notifyReport } = await import("@/lib/email/notify");
const { processNotifications } = await import("./notify");

/** An admin viewer whose user row exists, so `ensureProfile` can bridge it. */
async function makeAdmin(tx: TestDb): Promise<Viewer & { role: "admin" }> {
  const userId = `u_${randomUUID()}`;
  await tx
    .insert(user)
    .values({ id: userId, name: "Mo Moderator", email: `${userId}@example.test`, emailVerified: true });
  return { role: "admin", userId };
}

const ENV = { ...process.env };

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ sent: true, id: "eml_1" });
  process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.co.uk";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";
});

afterEach(() => {
  process.env = { ...ENV };
});

function recipients(): string[] {
  return sendEmail.mock.calls.map((c) => String(c[0]!.to));
}

function bodies(): string {
  return sendEmail.mock.calls.map((c) => String(c[0]!.text)).join("\n");
}

async function jobRow(tx: TestDb) {
  const [row] = await tx.select().from(jobQueue).limit(1);
  return row!;
}

async function queuedReport(tx: TestDb, patch: Record<string, unknown> = {}) {
  const ctx = await makeScaffold(tx);
  const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });
  const filed = await createReport(tx, PUBLIC_VIEWER, {
    listingId,
    reason: "closed",
    detail: "They shut in March.",
    reporterEmail: "spotter@example.co.uk",
    ip: null,
    ...patch,
  });
  await notifyReport(tx, PUBLIC_VIEWER, filed);
  return filed;
}

async function queuedRemoval(tx: TestDb) {
  const ctx = await makeScaffold(tx);
  const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });
  const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
    listingId,
    requesterName: "Alex Owner",
    requesterEmail: "alex@example.co.uk",
    relationship: "owner",
    reason: null,
    ip: null,
  });
  await notifyRemoval(tx, PUBLIC_VIEWER, filed);
  return filed;
}

/** A removal request an admin has already decided, with the decision's own job queued. */
async function queuedRemovalDecision(tx: TestDb, decision: "actioned" | "rejected") {
  const admin = await makeAdmin(tx);
  const ctx = await makeScaffold(tx);
  const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });
  const filed = await createRemovalRequest(tx, PUBLIC_VIEWER, {
    listingId,
    requesterName: "Alex Owner",
    requesterEmail: "alex@example.co.uk",
    relationship: "owner",
    reason: null,
    ip: null,
  });
  if (filed.outcome !== "created") throw new Error("setup failed");
  await actionRemovalRequest(tx, admin, filed.removalRequestId, decision);
  return filed;
}

describe("processNotifications — reports", () => {
  it("emails the admin and marks the job done", async () => {
    await withTestDb(async (tx) => {
      await queuedReport(tx);

      expect(await processNotifications(tx)).toBe(1);
      expect(recipients()).toEqual(["admin@example.co.uk"]);
      expect((await jobRow(tx)).status).toBe("done");
    });
  });

  it("carries the listing, the reason and a link to the page", async () => {
    await withTestDb(async (tx) => {
      await queuedReport(tx);
      await processNotifications(tx);

      const body = bodies();
      expect(body).toContain("The Old Mill");
      expect(body).toContain("They shut in March.");
      expect(body).toContain("https://example.co.uk/");
      expect(sendEmail.mock.calls[0]![0]!.replyTo).toBe("spotter@example.co.uk");
    });
  });

  it("queues nothing when the report was refused", async () => {
    await withTestDb(async (tx) => {
      await notifyReport(tx, PUBLIC_VIEWER, { outcome: "unknown-listing" });
      expect(await tx.select().from(jobQueue)).toHaveLength(0);
    });
  });

  it("fails the job rather than the tick when the report has gone", async () => {
    await withTestDb(async (tx) => {
      const filed = await queuedReport(tx);
      if (filed.outcome !== "created") throw new Error("setup failed");
      await tx.delete(reports);

      expect(await processNotifications(tx)).toBe(0);
      const job = await jobRow(tx);
      expect(job.status).toBe("pending");
      expect(job.lastError).toMatch(/report/i);
    });
  });
});

describe("processNotifications — removal requests", () => {
  it("acknowledges the requester and tells the admin, then marks the job done", async () => {
    await withTestDb(async (tx) => {
      await queuedRemoval(tx);

      expect(await processNotifications(tx)).toBe(1);
      // The person waiting for an answer goes first; the admin copy is our
      // own record and must not hold up the acknowledgement they are owed.
      expect(recipients()).toEqual(["alex@example.co.uk", "admin@example.co.uk"]);
      expect((await jobRow(tx)).status).toBe("done");
    });
  });

  it("states the five-working-day promise to the person who asked", async () => {
    await withTestDb(async (tx) => {
      await queuedRemoval(tx);
      await processNotifications(tx);

      const toRequester = String(sendEmail.mock.calls[0]![0]!.text);
      expect(toRequester).toContain("5 working days");
      expect(toRequester).toContain("The Old Mill");
    });
  });

  it("does not acknowledge twice when the admin send is retried", async () => {
    await withTestDb(async (tx) => {
      await queuedRemoval(tx);
      sendEmail.mockImplementation(async (m) =>
        String(m.to) === "admin@example.co.uk"
          ? { sent: false, reason: "rejected", error: "no such mailbox" }
          : { sent: true, id: "eml_1" },
      );

      await processNotifications(tx);
      await tx.update(jobQueue).set({ runAfter: new Date(Date.now() - 60_000) });
      await processNotifications(tx);

      expect(recipients().filter((r) => r === "alex@example.co.uk")).toHaveLength(1);
    });
  });

  it("queues nothing when the request was refused", async () => {
    await withTestDb(async (tx) => {
      await notifyRemoval(tx, PUBLIC_VIEWER, { outcome: "unknown-listing" });
      expect(await tx.select().from(jobQueue)).toHaveLength(0);
    });
  });
});

describe("processNotifications — removal decisions", () => {
  it("emails the requester alone when a removal is actioned", async () => {
    await withTestDb(async (tx) => {
      await queuedRemovalDecision(tx, "actioned");

      expect(await processNotifications(tx)).toBe(1);
      expect(recipients()).toEqual(["alex@example.co.uk"]);
      expect((await jobRow(tx)).status).toBe("done");

      const body = bodies();
      expect(body).toContain("The Old Mill");
    });
  });

  it("emails the requester alone when a removal is rejected", async () => {
    await withTestDb(async (tx) => {
      await queuedRemovalDecision(tx, "rejected");

      expect(await processNotifications(tx)).toBe(1);
      expect(recipients()).toEqual(["alex@example.co.uk"]);
      expect((await jobRow(tx)).status).toBe("done");
    });
  });

  it("retries a bounced send rather than silently dropping the notification", async () => {
    await withTestDb(async (tx) => {
      await queuedRemovalDecision(tx, "actioned");
      sendEmail.mockResolvedValueOnce({ sent: false, reason: "rejected", error: "bounced" });

      expect(await processNotifications(tx)).toBe(0);
      expect((await jobRow(tx)).status).toBe("pending");

      await tx.update(jobQueue).set({ runAfter: new Date(Date.now() - 60_000) });
      expect(await processNotifications(tx)).toBe(1);
      expect(recipients()).toEqual(["alex@example.co.uk", "alex@example.co.uk"]);
      expect((await jobRow(tx)).status).toBe("done");
    });
  });

  it("does not process a decision job twice once it is done", async () => {
    await withTestDb(async (tx) => {
      await queuedRemovalDecision(tx, "actioned");

      await processNotifications(tx);
      await tx.update(jobQueue).set({ runAfter: new Date(Date.now() - 60_000) });
      expect(await processNotifications(tx)).toBe(0);

      expect(recipients()).toEqual(["alex@example.co.uk"]);
    });
  });

  it("fails the job rather than the tick when there is nobody to tell", async () => {
    await withTestDb(async (tx) => {
      const filed = await queuedRemovalDecision(tx, "actioned");
      // The address has gone missing, so the read model has nobody to notify —
      // mirrors the "request has gone" case above without deleting a row a
      // foreign key still points at.
      await tx.update(removalRequests).set({ requesterEmail: null }).where(
        eq(removalRequests.id, filed.removalRequestId),
      );

      expect(await processNotifications(tx)).toBe(0);
      const job = await jobRow(tx);
      expect(job.status).toBe("pending");
      expect(job.lastError).toMatch(/removal/i);
    });
  });
});
