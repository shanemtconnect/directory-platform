import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { enquiries, jobQueue } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { makeCity, makeScaffold, makeListing } from "@/test/factories";
import { createEnquiry } from "@/lib/db/queries/enquiries";
import { createSubmission } from "@/lib/db/queries/submissions";
import type { SendResult } from "@/lib/email/sender";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();

vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { notifyEnquiry, notifySubmission, NOTIFY_ENQUIRY } = await import("@/lib/email/notify");
const { enqueueJob } = await import("@/lib/db/queries/jobs");
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

async function queuedEnquiry(tx: TestDb, patch: Record<string, unknown> = {}) {
  const ctx = await makeScaffold(tx);
  const listingId = await makeListing(tx, ctx, { name: "The Old Mill", ...patch });
  const created = await createEnquiry(tx, PUBLIC_VIEWER, {
    listingId,
    name: "Sam Enquirer",
    email: "sam@example.co.uk",
    phone: null,
    message: "Do you have a date free in June?",
    ip: null,
  });
  await notifyEnquiry(tx, PUBLIC_VIEWER, created);
  return listingId;
}

async function jobRow(tx: TestDb) {
  const [row] = await tx.select().from(jobQueue).limit(1);
  return row!;
}

/** Brings a backed-off job forward, so the next call is the next tick. */
async function rearm(tx: TestDb) {
  await tx.update(jobQueue).set({ runAfter: new Date(Date.now() - 60_000) });
}

/** Rejects mail to `address` and accepts everything else. */
function rejectsMailTo(address: string) {
  sendEmail.mockImplementation(async (m) =>
    String(m.to) === address
      ? { sent: false, reason: "rejected", error: "no such mailbox" }
      : { sent: true, id: "eml_1" },
  );
}

describe("processNotifications — enquiries", () => {
  it("emails the admin and marks the job done", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx);

      expect(await processNotifications(tx)).toBe(1);
      expect(recipients()).toEqual(["admin@example.co.uk"]);
      expect((await jobRow(tx)).status).toBe("done");
    });
  });

  it("carries the enquiry and replies to the person who sent it", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx);
      await processNotifications(tx);

      const message = sendEmail.mock.calls[0]![0]!;
      expect(String(message.text)).toContain("Do you have a date free in June?");
      expect(String(message.text)).toContain("The Old Mill");
      expect(message.replyTo).toBe("sam@example.co.uk");
    });
  });

  it("does not email an unclaimed listing's contact address", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx, { email: "scraped@example.co.uk", claimStatus: "unclaimed" });
      await processNotifications(tx);

      expect(recipients()).toEqual(["admin@example.co.uk"]);
    });
  });

  it("emails the owner as well once the listing is claimed", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx, { email: "owner@example.co.uk", claimStatus: "claimed" });
      await processNotifications(tx);

      expect(recipients()).toEqual(["owner@example.co.uk", "admin@example.co.uk"]);
    });
  });

  it("emails only the admin when a claimed listing has no address on file", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx, { email: null, claimStatus: "verified" });
      await processNotifications(tx);

      expect(recipients()).toEqual(["admin@example.co.uk"]);
    });
  });

  it("retries the job when the provider rejects the send", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx);
      sendEmail.mockResolvedValue({ sent: false, reason: "rejected", error: "quota exceeded" });

      expect(await processNotifications(tx)).toBe(0);
      const job = await jobRow(tx);
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(1);
      expect(job.lastError).toContain("quota exceeded");
    });
  });

  it("completes the job when no mail is configured, rather than queueing for ever", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx);
      sendEmail.mockResolvedValue({ sent: false, reason: "not-configured" });

      expect(await processNotifications(tx)).toBe(1);
      expect((await jobRow(tx)).status).toBe("done");
    });
  });

  it("fails the job rather than the tick when the enquiry has gone", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx);
      await tx.delete(enquiries);

      expect(await processNotifications(tx)).toBe(0);
      expect(sendEmail).not.toHaveBeenCalled();
      expect((await jobRow(tx)).status).toBe("pending");
      expect((await jobRow(tx)).attempts).toBe(1);
    });
  });

  it("falls back to the address when the enquirer left no name", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx);
      await tx.update(enquiries).set({ name: null });
      await processNotifications(tx);

      const message = sendEmail.mock.calls[0]![0]!;
      expect(String(message.text)).toContain("sam@example.co.uk");
      expect(String(message.text)).not.toContain("undefined");
    });
  });

  it("does not try to notify an enquiry with no address to reply to", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx);
      await tx.update(enquiries).set({ email: null });

      expect(await processNotifications(tx)).toBe(0);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  it("queues nothing when the enquiry was refused", async () => {
    await withTestDb(async (tx) => {
      const refused = await createEnquiry(tx, PUBLIC_VIEWER, {
        listingId: "00000000-0000-4000-8000-0000000000bb",
        name: "Sam Enquirer",
        email: "sam@example.co.uk",
        phone: null,
        message: "Anyone there?",
        ip: null,
      });
      expect(refused.outcome).toBe("unknown-listing");
      await notifyEnquiry(tx, PUBLIC_VIEWER, refused);

      expect(await tx.select().from(jobQueue)).toHaveLength(0);
    });
  });

  it("does not send the owner a second copy when the admin send is retried", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx, { email: "owner@example.co.uk", claimStatus: "claimed" });
      rejectsMailTo("admin@example.co.uk");

      expect(await processNotifications(tx)).toBe(0);
      await rearm(tx);
      expect(await processNotifications(tx)).toBe(0);
      await rearm(tx);
      expect(await processNotifications(tx)).toBe(0);

      // The owner is told once. Only the recipient that failed is tried again.
      expect(recipients()).toEqual([
        "owner@example.co.uk",
        "admin@example.co.uk",
        "admin@example.co.uk",
        "admin@example.co.uk",
      ]);
      expect((await jobRow(tx)).attempts).toBe(3);
    });
  });

  it("records on the job which recipients it has already reached", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx, { email: "owner@example.co.uk", claimStatus: "claimed" });
      rejectsMailTo("admin@example.co.uk");

      await processNotifications(tx);

      expect((await jobRow(tx)).delivered).toEqual(["owner"]);
    });
  });

  it("keeps the job it has already finished when a later one hits a database error", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx);
      // Deterministic order: the good job is due first.
      await tx.update(jobQueue).set({ runAfter: new Date(Date.now() - 120_000) });
      // An id Postgres itself refuses, so the failure is a driver-level error
      // mid-batch rather than one the handler chose to raise.
      const badId = await enqueueJob(tx, ADMIN_VIEWER, {
        kind: NOTIFY_ENQUIRY,
        payload: { enquiryId: "not-a-uuid" },
        runAfter: new Date(Date.now() - 60_000),
      });

      expect(await processNotifications(tx)).toBe(1);

      const rows = await tx.select().from(jobQueue);
      const good = rows.find((r) => r.id !== badId)!;
      const bad = rows.find((r) => r.id === badId)!;
      // The email for the first job went out. Undoing its completion would
      // send it again on the next tick.
      expect(good.status).toBe("done");
      expect(bad.status).toBe("pending");
      expect(bad.attempts).toBe(1);
      expect(recipients()).toEqual(["admin@example.co.uk"]);
    });
  });

  it("drains everything waiting in one tick", async () => {
    await withTestDb(async (tx) => {
      await queuedEnquiry(tx);
      await queuedEnquiry(tx);

      expect(await processNotifications(tx)).toBe(2);
      expect(recipients()).toHaveLength(2);
    });
  });
});

const submission = {
  name: "The Old Mill",
  region: null,
  city: "Testville",
  addressLine1: "1 Mill Lane",
  postcode: "BA1 1AA",
  phone: "01632 960111",
  website: null,
  description: "A long enough description to look like a real one.",
  submitterName: "Alex Owner",
  submitterEmail: "alex@example.co.uk",
  requestedTier: "free" as const,
  ip: null,
};

describe("processNotifications — submissions", () => {
  it("emails the admin and the submitter, and marks the job done", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const saved = await createSubmission(tx, PUBLIC_VIEWER, {
        ...submission,
        categoryId: ctx.primaryCategoryId,
        city: await cityNameFor(tx, ctx.cityId),
      });
      await notifySubmission(tx, PUBLIC_VIEWER, saved);

      expect(await processNotifications(tx)).toBe(1);
      // The receipt first: a failure to reach the admin must not swallow it.
      expect(recipients()).toEqual(["alex@example.co.uk", "admin@example.co.uk"]);
      expect((await jobRow(tx)).status).toBe("done");
    });
  });

  it("still tells the admin about a submission parked for a town it cannot place", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      // Two of them and no county given: unresolvable, so the payload parks
      // instead of becoming a listing. An unheard-of town is created now.
      await makeCity(tx, "Newport", "Isle of Wight");
      await makeCity(tx, "Newport", "Pembrokeshire");
      const saved = await createSubmission(tx, PUBLIC_VIEWER, {
        ...submission,
        categoryId: ctx.primaryCategoryId,
        city: "Newport",
        region: null,
      });
      expect(saved.outcome).toBe("parked");
      await notifySubmission(tx, PUBLIC_VIEWER, saved);

      expect(await processNotifications(tx)).toBe(1);
      expect(recipients()).toEqual(["alex@example.co.uk", "admin@example.co.uk"]);
      expect(String(sendEmail.mock.calls[1]![0]!.text)).toContain("parked queue");
    });
  });

  it("does not send the submitter a second receipt when the admin send is retried", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const saved = await createSubmission(tx, PUBLIC_VIEWER, {
        ...submission,
        categoryId: ctx.primaryCategoryId,
        city: await cityNameFor(tx, ctx.cityId),
      });
      await notifySubmission(tx, PUBLIC_VIEWER, saved);
      rejectsMailTo("admin@example.co.uk");

      expect(await processNotifications(tx)).toBe(0);
      await rearm(tx);
      expect(await processNotifications(tx)).toBe(0);

      expect(recipients()).toEqual([
        "alex@example.co.uk",
        "admin@example.co.uk",
        "admin@example.co.uk",
      ]);
    });
  });

  it("queues nothing at all when the category was not recognised", async () => {
    await withTestDb(async (tx) => {
      const saved = await createSubmission(tx, PUBLIC_VIEWER, {
        ...submission,
        categoryId: "00000000-0000-4000-8000-0000000000ff",
      });
      expect(saved.outcome).toBe("unknown-category");
      await notifySubmission(tx, PUBLIC_VIEWER, saved);

      const rows = await tx.select().from(jobQueue);
      expect(rows).toHaveLength(0);
    });
  });
});

describe("the queue is not readable by anyone but the worker", () => {
  it("refuses a non-admin viewer on the read model", async () => {
    await withTestDb(async (tx) => {
      const { enquiryNotification } = await import("@/lib/db/queries/notifications");
      await expect(
        enquiryNotification(tx, PUBLIC_VIEWER, "00000000-0000-4000-8000-0000000000aa"),
      ).rejects.toThrow(/FORBIDDEN/);
      // The worker's own viewer is allowed and simply finds nothing.
      expect(
        await enquiryNotification(tx, ADMIN_VIEWER, "00000000-0000-4000-8000-0000000000aa"),
      ).toBeNull();
    });
  });
});

async function cityNameFor(tx: TestDb, cityId: string): Promise<string> {
  const { cities } = await import("@/lib/db/schema");
  const [row] = await tx.select({ name: cities.name }).from(cities).where(eq(cities.id, cityId));
  return row!.name;
}
