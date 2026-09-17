import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, jobQueue, listings, subscriptions, user } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { ensureProfile } from "@/lib/auth/profile";
import { resetClock, setClock } from "@/lib/clock";
import { createPendingSubscription, REMINDER_ACTION } from "@/lib/db/queries/billing";
import { NOTIFY_BILLING_REMINDER } from "@/lib/email/notify";
import { drainBillingNotifications, enqueueDueReminders } from "./renewal-reminders";

/**
 * The mail provider is replaced so the RECIPIENT can be asserted. The real
 * sender has no credentials in the test environment and reports
 * "not-configured", which the job treats as complete — the same completion
 * these tests expect, only now with the address visible.
 */
const sent: { to: string }[] = [];
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (message: { to: string }) => {
    sent.push({ to: message.to });
    return { sent: true, id: `m-${sent.length}` };
  },
}));

beforeEach(() => {
  sent.length = 0;
});
afterEach(() => resetClock());

async function activeSubscription(tx: TestDb, patch: Partial<typeof subscriptions.$inferInsert> = {}) {
  const ctx = await makeScaffold(tx);
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "O", email: `${userId}@example.test` });
  const viewer = { role: "user" as const, userId };
  const { id: profileId } = await ensureProfile(tx, viewer);
  const listingId = await makeListing(tx, ctx, {
    ownerId: profileId,
    claimStatus: "claimed",
    tier: "premium",
    email: "owner@example.test",
  });
  const id = await createPendingSubscription(tx, viewer, {
    listingId,
    profileId,
    tier: "premium",
    interval: "annual",
    providerPlanId: "P-1",
    ip: null,
  });
  await tx
    .update(subscriptions)
    .set({
      status: "active",
      providerSubscriptionId: `I-${randomUUID().slice(0, 8)}`,
      currentPeriodEnd: new Date("2026-10-12T09:00:00Z"),
      ...patch,
    })
    .where(eq(subscriptions.id, id));
  return { id, listingId };
}

describe("enqueueDueReminders", () => {
  it("queues one reminder per offset window and records that it did", async () => {
    await withTestDb(async (tx) => {
      const s = await activeSubscription(tx);
      // 30 days before 12 October is 12 September.
      setClock(new Date("2026-09-12T04:00:00Z"));

      expect(await enqueueDueReminders(tx)).toBe(1);

      const queued = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_BILLING_REMINDER));
      expect(queued).toHaveLength(1);
      expect(queued[0]!.payload).toMatchObject({ subscriptionId: s.id, offsetDays: 30 });

      const audits = await tx.select().from(auditLog).where(eq(auditLog.action, REMINDER_ACTION));
      expect(audits).toHaveLength(1);
    });
  });

  it("is safe to run every hour — the same reminder is queued once", async () => {
    await withTestDb(async (tx) => {
      await activeSubscription(tx);
      setClock(new Date("2026-09-12T04:00:00Z"));
      await enqueueDueReminders(tx);
      setClock(new Date("2026-09-12T05:00:00Z"));
      expect(await enqueueDueReminders(tx)).toBe(0);
      expect(await tx.select().from(jobQueue)).toHaveLength(1);
    });
  });

  it("sends the 7-day and the day-of reminders as the clock moves", async () => {
    await withTestDb(async (tx) => {
      await activeSubscription(tx);
      setClock(new Date("2026-10-05T04:00:00Z"));
      expect(await enqueueDueReminders(tx)).toBe(1);
      setClock(new Date("2026-10-12T04:00:00Z"));
      expect(await enqueueDueReminders(tx)).toBe(1);

      const queued = await tx.select().from(jobQueue);
      expect(queued.map((j) => (j.payload as { offsetDays: number }).offsetDays).sort()).toEqual([0, 7]);
    });
  });

  it("says nothing to somebody who has already cancelled", async () => {
    await withTestDb(async (tx) => {
      await activeSubscription(tx, { cancelAtPeriodEnd: true });
      setClock(new Date("2026-09-12T04:00:00Z"));
      expect(await enqueueDueReminders(tx)).toBe(0);
    });
  });
});

describe("drainBillingNotifications", () => {
  it("completes a queued reminder", async () => {
    await withTestDb(async (tx) => {
      await activeSubscription(tx);
      setClock(new Date("2026-09-12T04:00:00Z"));
      await enqueueDueReminders(tx);

      // No mail credentials in the test environment, so sendEmail reports
      // "not-configured" — which is a completed job, not a failed one.
      expect(await drainBillingNotifications(tx)).toBe(1);

      const [job] = await tx.select().from(jobQueue);
      expect(job!.status).toBe("done");
    });
  });

  it("drops a reminder for a subscription cancelled since it was queued", async () => {
    await withTestDb(async (tx) => {
      const s = await activeSubscription(tx);
      setClock(new Date("2026-09-12T04:00:00Z"));
      await enqueueDueReminders(tx);

      await tx
        .update(subscriptions)
        .set({ cancelAtPeriodEnd: true })
        .where(eq(subscriptions.id, s.id));

      expect(await drainBillingNotifications(tx)).toBe(1);
      const [job] = await tx.select().from(jobQueue);
      expect(job!.status).toBe("done");
      expect(job!.lastError).toBeNull();
    });
  });

  it("writes to the payer's account email, not the listing's enquiry address", async () => {
    await withTestDb(async (tx) => {
      const s = await activeSubscription(tx);
      setClock(new Date("2026-09-12T04:00:00Z"));
      await enqueueDueReminders(tx);

      expect(await drainBillingNotifications(tx)).toBe(1);
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, s.id));
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).not.toBe("owner@example.test");
      expect(sent[0]!.to).toMatch(/^u_.+@example\.test$/);
      expect(sub!.userId).not.toBeNull();
    });
  });

  it("still sends, to the payer, when the listing has no public address", async () => {
    await withTestDb(async (tx) => {
      const s = await activeSubscription(tx);
      await tx.update(listings).set({ email: null }).where(eq(listings.id, s.listingId));
      setClock(new Date("2026-09-12T04:00:00Z"));
      await enqueueDueReminders(tx);

      expect(await drainBillingNotifications(tx)).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toMatch(/^u_.+@example\.test$/);
    });
  });

  it("completes rather than retries when there is no address at all", async () => {
    await withTestDb(async (tx) => {
      const s = await activeSubscription(tx);
      await tx.update(listings).set({ email: null }).where(eq(listings.id, s.listingId));
      await tx.update(subscriptions).set({ userId: null }).where(eq(subscriptions.id, s.id));
      setClock(new Date("2026-09-12T04:00:00Z"));
      await enqueueDueReminders(tx);

      expect(await drainBillingNotifications(tx)).toBe(1);
      expect(sent).toHaveLength(0);
      const [job] = await tx.select().from(jobQueue);
      expect(job!.status).toBe("done");
    });
  });
});
