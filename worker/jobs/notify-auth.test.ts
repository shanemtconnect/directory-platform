import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import { jobQueue, user } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import type { SendResult } from "@/lib/email/sender";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();

vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { NOTIFY_AUTH_RESET, NOTIFY_AUTH_VERIFY, notifyAuthEmail } = await import(
  "@/lib/email/notify"
);
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

async function makeAccount(tx: TestDb): Promise<{ userId: string; email: string }> {
  const userId = `u_${randomUUID()}`;
  const email = `${userId}@example.test`;
  await tx.insert(user).values({ id: userId, name: "Sam Owner", email, emailVerified: false });
  return { userId, email };
}

function sent(): Array<Record<string, unknown>> {
  return sendEmail.mock.calls.map((c) => c[0]!);
}

describe("the auth notifications", () => {
  it("sends a reset link to the account's own address and nobody else", async () => {
    await withTestDb(async (tx) => {
      const { userId, email } = await makeAccount(tx);
      await notifyAuthEmail(tx, PUBLIC_VIEWER, NOTIFY_AUTH_RESET, {
        userId,
        url: "https://example.co.uk/reset-password?token=tok_123",
      });

      expect(await processNotifications(tx)).toBe(1);
      // Never the admin: a reset link in our own inbox is a way into
      // somebody else's account.
      expect(sent().map((m) => m.to)).toEqual([email]);
      expect(String(sent()[0]!.text)).toContain("tok_123");
    });
  });

  it("sends the verification link the same way", async () => {
    await withTestDb(async (tx) => {
      const { userId, email } = await makeAccount(tx);
      await notifyAuthEmail(tx, PUBLIC_VIEWER, NOTIFY_AUTH_VERIFY, {
        userId,
        url: "https://example.co.uk/api/auth/verify-email?token=tok_v",
      });

      expect(await processNotifications(tx)).toBe(1);
      expect(sent().map((m) => m.to)).toEqual([email]);
      expect(String(sent()[0]!.subject).toLowerCase()).toContain("confirm");
    });
  });

  it("keeps the address out of the queue and reads it at send time", async () => {
    await withTestDb(async (tx) => {
      const { userId, email } = await makeAccount(tx);
      await notifyAuthEmail(tx, PUBLIC_VIEWER, NOTIFY_AUTH_RESET, {
        userId,
        url: "https://example.co.uk/reset-password?token=t",
      });
      const [row] = await tx.select().from(jobQueue).limit(1);
      expect(JSON.stringify(row!.payload)).not.toContain(email);
    });
  });

  it("does not retry forever for an account that has been deleted", async () => {
    await withTestDb(async (tx) => {
      const { userId } = await makeAccount(tx);
      await notifyAuthEmail(tx, PUBLIC_VIEWER, NOTIFY_AUTH_RESET, {
        userId,
        url: "https://example.co.uk/reset-password?token=t",
      });
      await tx.delete(user).where(eq(user.id, userId));

      expect(await processNotifications(tx)).toBe(1);
      // Nothing to send, and nothing left in the queue to keep trying.
      expect(sendEmail).not.toHaveBeenCalled();
      const [row] = await tx.select().from(jobQueue).limit(1);
      expect(row!.status).toBe("done");
    });
  });

  it("retries a job that names no account", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(jobQueue).values({ kind: NOTIFY_AUTH_RESET, payload: { url: "/x" } });
      expect(await processNotifications(tx)).toBe(0);
      const [row] = await tx.select().from(jobQueue).limit(1);
      expect(row!.lastError).toMatch(/userId/);
    });
  });

  it("refuses a URL that is not on this site", async () => {
    // The URL comes from Better Auth, built from BETTER_AUTH_URL — but it lands
    // in a queue row and comes back out as untyped jsonb, so the thing that
    // renders a clickable link into somebody's inbox checks it.
    await withTestDb(async (tx) => {
      const { userId } = await makeAccount(tx);
      await tx.insert(jobQueue).values({
        kind: NOTIFY_AUTH_RESET,
        payload: { userId, url: "https://evil.example/reset-password?token=t" },
      });

      expect(await processNotifications(tx)).toBe(0);
      expect(sendEmail).not.toHaveBeenCalled();
      const [row] = await tx.select().from(jobQueue).limit(1);
      expect(row!.lastError).toMatch(/url/i);
      // The reason is recorded; the token is not. `last_error` is a column an
      // admin reads, and a log line is a place a reset link must never appear.
      expect(row!.lastError).not.toContain("token=t");
      expect(row!.lastError).not.toContain("/reset-password");
    });
  });
});
