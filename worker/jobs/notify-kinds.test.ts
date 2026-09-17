import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { jobQueue } from "@/lib/db/schema";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { SendResult } from "@/lib/email/sender";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();
vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { NOTIFY_KINDS, BILLING_NOTIFY_KINDS } = await import("@/lib/email/notify");
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

/**
 * The list the worker CLAIMS and the switch it DISPATCHES on are two places.
 * A kind in one and not the other is a job that retries five times and parks,
 * with "No handler for job kind" as the only clue. Every kind goes through
 * `run` here with an empty payload: the handlers fail on the missing id,
 * which is fine — what must never appear is the default branch's message.
 */
describe("NOTIFY_KINDS", () => {
  it("is one literal with no duplicates, and disjoint from the billing kinds", () => {
    expect(NOTIFY_KINDS.length).toBeGreaterThanOrEqual(14);
    expect(new Set(NOTIFY_KINDS).size).toBe(NOTIFY_KINDS.length);
    for (const kind of BILLING_NOTIFY_KINDS) expect(NOTIFY_KINDS).not.toContain(kind);
  });

  it("every kind has a case in worker/jobs/notify.ts run", async () => {
    await withTestDb(async (tx) => {
      const ids: string[] = [];
      for (const kind of NOTIFY_KINDS) {
        ids.push(await enqueueJob(tx, ADMIN_VIEWER, { kind, payload: {} }));
      }

      await processNotifications(tx);

      const rows = await tx
        .select({ kind: jobQueue.kind, lastError: jobQueue.lastError })
        .from(jobQueue)
        .where(inArray(jobQueue.id, ids));
      expect(rows).toHaveLength(NOTIFY_KINDS.length);
      const unhandled = rows.filter((r) => r.lastError?.startsWith("No handler for job kind"));
      expect(unhandled.map((r) => r.kind)).toEqual([]);
    });
  });
});
