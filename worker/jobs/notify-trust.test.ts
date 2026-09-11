import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import { jobQueue, reports } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeScaffold, makeListing } from "@/test/factories";
import { createRemovalRequest, createReport } from "@/lib/db/queries/trust";
import type { SendResult } from "@/lib/email/sender";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();

vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { notifyRemoval, notifyReport } = await import("@/lib/email/notify");
const { processNotifications } = await import("./notify");

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
