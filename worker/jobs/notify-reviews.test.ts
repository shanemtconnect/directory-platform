import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { jobQueue, reviewInvites } from "@/lib/db/schema";
import { makeListing, makeScaffold } from "@/test/factories";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { hashToken } from "@/lib/security/token-hash";
import type { SendResult } from "@/lib/email/sender";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();

vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { notifyReviewResent, notifyReviewSubmitted } = await import("@/lib/email/notify");
const { createReview, resendReviewVerification, verifyReviewToken } = await import(
  "@/lib/db/queries/reviews"
);
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

function sentTo(): string[] {
  return sendEmail.mock.calls.map((c) => String(c[0]!.to));
}

function bodies(): string {
  return sendEmail.mock.calls.map((c) => String(c[0]!.text)).join("\n");
}

async function submitted(tx: TestDb) {
  const ctx = await makeScaffold(tx);
  const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
  const email = `sam-${randomUUID()}@example.test`;
  const created = await createReview(tx, PUBLIC_VIEWER, {
    listingId,
    rating: 5,
    subRatings: null,
    title: "Did exactly what they said",
    body: "Turned up on time, did the job, left the place tidy. Would use them again without a second thought.",
    displayName: "Sam P",
    email,
    ip: null,
  });
  if (created.outcome !== "created") throw new Error(`setup failed: ${created.outcome}`);
  return { listingId, email, created };
}

describe("notify.review.submitted", () => {
  it("emails the verification link, built from the payload's token, to the reviewer", async () => {
    await withTestDb(async (tx) => {
      const { email, created } = await submitted(tx);
      await notifyReviewSubmitted(tx, PUBLIC_VIEWER, created);

      expect(await processNotifications(tx)).toBe(1);
      expect(sentTo()).toEqual([email]);
      expect(bodies()).toContain(`https://example.co.uk/review/verify/${created.token}`);
    });
  });

  it("carries the raw token in the payload only until the job is done", async () => {
    await withTestDb(async (tx) => {
      const { listingId, created } = await submitted(tx);
      await notifyReviewSubmitted(tx, PUBLIC_VIEWER, created);

      const [before] = await tx.select().from(jobQueue);
      expect(before?.payload).toEqual({ reviewId: created.reviewId, token: created.token });
      const [invite] = await tx.select().from(reviewInvites)
        .where(eq(reviewInvites.listingId, listingId));
      expect(invite?.token).toBe(hashToken(created.token));

      expect(await processNotifications(tx)).toBe(1);
      const [after] = await tx.select().from(jobQueue);
      expect(after?.status).toBe("done");
      expect(after?.payload).toEqual({ reviewId: created.reviewId });
    });
  });

  it("sends the resent link and not the one it replaced", async () => {
    await withTestDb(async (tx) => {
      const { listingId, email, created } = await submitted(tx);
      await notifyReviewSubmitted(tx, PUBLIC_VIEWER, created);
      await tx.update(reviewInvites).set({ sentAt: new Date("2020-01-01T00:00:00Z") })
        .where(eq(reviewInvites.listingId, listingId));
      const resent = await resendReviewVerification(tx, PUBLIC_VIEWER, created.token);
      if (resent.outcome !== "sent") throw new Error("setup failed");
      await notifyReviewResent(tx, PUBLIC_VIEWER, resent);

      // Both jobs complete; only the live link goes out.
      expect(await processNotifications(tx)).toBe(2);
      expect(sentTo()).toEqual([email]);
      expect(bodies()).not.toContain(created.token);
      expect(bodies()).toContain(resent.token);
    });
  });

  it("completes without sending once the link has been used", async () => {
    await withTestDb(async (tx) => {
      const { created } = await submitted(tx);
      await notifyReviewSubmitted(tx, PUBLIC_VIEWER, created);
      await verifyReviewToken(tx, PUBLIC_VIEWER, created.token);

      expect(await processNotifications(tx)).toBe(1);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  it("retries a job that carries no token rather than mailing a dead link", async () => {
    await withTestDb(async (tx) => {
      const { created } = await submitted(tx);
      await enqueueJob(tx, PUBLIC_VIEWER, {
        kind: "notify.review.submitted", payload: { reviewId: created.reviewId },
      });

      expect(await processNotifications(tx)).toBe(0);
      expect(sendEmail).not.toHaveBeenCalled();
      const [job] = await tx.select().from(jobQueue);
      expect(job?.status).toBe("pending");
      expect(job?.lastError).toMatch(/token/);
      expect(job?.lastError).not.toContain(created.token);
    });
  });
});
