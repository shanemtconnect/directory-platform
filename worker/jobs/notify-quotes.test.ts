import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import { jobQueue, profiles, unsubscribes, user } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { createQuoteRequest, verifyQuoteToken } from "@/lib/db/queries/quotes";
import type { SendResult } from "@/lib/email/sender";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();

vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { notifyQuoteRequest, notifyQuoteVerify } = await import("@/lib/email/notify");
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

function sent(): { to: string; subject: string; text: string; replyTo: unknown }[] {
  return sendEmail.mock.calls.map((c) => ({
    to: String(c[0]!.to),
    subject: String(c[0]!.subject),
    text: String(c[0]!.text),
    replyTo: c[0]!.replyTo,
  }));
}

async function makeOwner(tx: TestDb, email: string): Promise<string> {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Owner", email });
  const [row] = await tx.insert(profiles).values({ userId }).returning({ id: profiles.id });
  return row!.id;
}

/** Submitted, NOT yet clicked: only the verification job is queued. */
async function submittedRequest(tx: TestDb, ctx: ListingCtx) {
  const created = await createQuoteRequest(tx, PUBLIC_VIEWER, {
    cityId: ctx.cityId,
    categoryId: ctx.primaryCategoryId,
    name: "Sam Requester",
    email: "sam@example.co.uk",
    phone: null,
    message: "Eighty people in June, with parking.",
    ip: null,
  });
  if (created.outcome !== "created") throw new Error(created.outcome);
  await notifyQuoteVerify(tx, PUBLIC_VIEWER, created);
  return created;
}

/** Submitted and clicked: the delivery job is queued, as the verify route leaves it. */
async function queuedRequest(tx: TestDb, ctx: ListingCtx): Promise<string> {
  const created = await createQuoteRequest(tx, PUBLIC_VIEWER, {
    cityId: ctx.cityId,
    categoryId: ctx.primaryCategoryId,
    name: "Sam Requester",
    email: "sam@example.co.uk",
    phone: null,
    message: "Eighty people in June, with parking.",
    ip: null,
  });
  if (created.outcome !== "created") throw new Error(created.outcome);
  const verified = await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token);
  if (verified.outcome !== "verified") throw new Error(verified.outcome);
  await notifyQuoteRequest(tx, PUBLIC_VIEWER, created.quoteRequestId);
  return created.quoteRequestId;
}

async function jobRow(tx: TestDb) {
  const [row] = await tx.select().from(jobQueue).limit(1);
  return row!;
}

describe("processNotifications — quotes", () => {
  it("emails each recipient at the right address, then acknowledges the requester with the real count", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const ownerProfile = await makeOwner(tx, "account@example.com");
      await makeListing(tx, ctx, {
        name: "Claimed Hall", email: "scraped@example.com", claimStatus: "claimed",
        ownerId: ownerProfile, tier: "premium",
      });
      await makeListing(tx, ctx, { name: "Unclaimed Hall", email: "listing@example.com" });
      await makeListing(tx, ctx, { name: "Silent Hall", email: null });
      await queuedRequest(tx, ctx);

      expect(await processNotifications(tx)).toBe(1);

      const mail = sent();
      expect(mail.map((m) => m.to)).toEqual(["account@example.com", "listing@example.com", "sam@example.co.uk"]);
      // The paid, claimed listing gets the job with reply-to the requester.
      expect(mail[0]!.text).toContain("Eighty people in June");
      expect(mail[0]!.replyTo).toBe("sam@example.co.uk");
      expect(mail[0]!.text).toContain("https://example.co.uk/account/listings/");
      // The free, unclaimed one is told a request arrived and nothing more.
      expect(mail[1]!.text).not.toContain("Eighty people");
      expect(mail[1]!.text).not.toContain("sam@example.co.uk");
      expect(mail[1]!.text).toContain("https://example.co.uk/pricing");
      // "sent to N": N is the two actually written to, not the three listings in town.
      expect(mail[2]!.subject).toMatch(/went to 2 /);
      expect((await jobRow(tx)).status).toBe("done");
    });
  });

  it("honours an unsubscribe made after the request was written", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "stays@example.com", tier: "premium" });
      await makeListing(tx, ctx, { email: "Gone@Example.com" });
      await queuedRequest(tx, ctx);
      await tx.insert(unsubscribes).values({ addressNormalised: "gone@example.com" });

      await processNotifications(tx);

      expect(sent().map((m) => m.to)).toEqual(["stays@example.com", "sam@example.co.uk"]);
      expect(sent()[1]!.subject).toMatch(/went to 1 /);
    });
  });

  it("a rejected address blocks nobody: the rest and the requester go out, and only it retries", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      // Named so the send order (createdAt, then name) is fixed: bad FIRST.
      await makeListing(tx, ctx, { name: "Alpha Hall", email: "bad@example.com", tier: "premium" });
      await makeListing(tx, ctx, { name: "Beta Hall", email: "second@example.com", tier: "essential" });
      await makeListing(tx, ctx, { name: "Gamma Hall", email: "third@example.com" });
      await queuedRequest(tx, ctx);
      sendEmail.mockImplementation(async (m) =>
        String(m.to) === "bad@example.com"
          ? { sent: false, reason: "rejected", error: "no such mailbox" }
          : { sent: true, id: "eml_1" },
      );

      expect(await processNotifications(tx)).toBe(0);
      // Everyone after the rejection was still written to on this tick, and
      // the requester was told the number that actually went out.
      expect(sent().map((m) => m.to)).toEqual([
        "bad@example.com", "second@example.com", "third@example.com", "sam@example.co.uk",
      ]);
      expect(sent()[3]!.subject).toMatch(/went to 2 /);
      const job = await jobRow(tx);
      expect(job.status).toBe("pending");
      expect(job.lastError).toContain("no such mailbox");
      expect([...job.delivered].sort()).toEqual([
        expect.stringMatching(/^recipient:/), expect.stringMatching(/^recipient:/), "requester",
      ]);

      // Next tick: only the rejected address is written to again.
      sendEmail.mockClear().mockResolvedValue({ sent: true, id: "eml_2" });
      await tx.update(jobQueue).set({ runAfter: new Date(Date.now() - 60_000) });
      expect(await processNotifications(tx)).toBe(1);
      expect(sent().map((m) => m.to)).toEqual(["bad@example.com"]);
    });
  });

  it("does not count a send the provider never saw", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com", tier: "premium" });
      await makeListing(tx, ctx, { email: "b@example.com" });
      await queuedRequest(tx, ctx);
      // The mailer is unconfigured for the recipients and (for the sake of
      // reading the count) configured for the requester.
      sendEmail.mockImplementation(async (m) =>
        String(m.to) === "sam@example.co.uk"
          ? { sent: true, id: "eml_1" }
          : { sent: false, reason: "not-configured" },
      );

      expect(await processNotifications(tx)).toBe(1);
      expect(sent().at(-1)!.subject).toMatch(/went to 0 /);
    });
  });

  it("puts a signed unsubscribe link in each recipient's email", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      await queuedRequest(tx, ctx);
      process.env.EMAIL_UNSUBSCRIBE_SECRET = "unit-test-secret";

      await processNotifications(tx);

      const text = sent()[0]!.text;
      const match = /https:\/\/example\.co\.uk\/unsubscribe\?t=([A-Za-z0-9_.-]+)/.exec(text);
      expect(match, "the recipient email must carry an unsubscribe link").not.toBeNull();
      const { verifyUnsubscribe } = await import("@/lib/email/unsubscribe");
      expect(verifyUnsubscribe(decodeURIComponent(match![1]!))?.email).toBe("a@example.com");
    });
  });

  it("completes without sending when the request has been flagged as spam", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const id = await queuedRequest(tx, ctx);
      const { quoteRequests } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      await tx.update(quoteRequests).set({ isSpam: true }).where(eq(quoteRequests.id, id));

      expect(await processNotifications(tx)).toBe(1);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });
});

describe("processNotifications — quote verification", () => {
  it("sends the requester the link, and only the requester, then scrubs the token", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com", tier: "premium" });
      const created = await submittedRequest(tx, ctx);

      expect(await processNotifications(tx)).toBe(1);

      const mail = sent();
      expect(mail.map((m) => m.to)).toEqual(["sam@example.co.uk"]);
      expect(mail[0]!.subject).toMatch(/confirm/i);
      expect(mail[0]!.text).toContain(
        `https://example.co.uk/get-quotes/verify/${encodeURIComponent(created.token)}`,
      );
      expect(mail[0]!.text).toContain("48 hours");
      const job = await jobRow(tx);
      expect(job).toMatchObject({ kind: "notify.quote-verify", status: "done" });
      expect(job.payload).toEqual({ quoteRequestId: created.quoteRequestId });
    });
  });

  it("sends nothing once the link has been clicked, or for a token that is not the live one", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const clicked = await submittedRequest(tx, ctx);
      await verifyQuoteToken(tx, PUBLIC_VIEWER, clicked.token);

      expect(await processNotifications(tx)).toBe(1);
      expect(sendEmail).not.toHaveBeenCalled();

      const { enqueueJob } = await import("@/lib/db/queries/jobs");
      const other = await submittedRequest(tx, ctx);
      await tx.delete(jobQueue);
      await enqueueJob(tx, PUBLIC_VIEWER, {
        kind: "notify.quote-verify", payload: { quoteRequestId: other.quoteRequestId, token: "forged" },
      });
      expect(await processNotifications(tx)).toBe(1);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  it("a delivery job for a request nobody confirmed sends nothing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const created = await submittedRequest(tx, ctx);
      await tx.delete(jobQueue);
      await notifyQuoteRequest(tx, PUBLIC_VIEWER, created.quoteRequestId);

      expect(await processNotifications(tx)).toBe(1);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });
});
