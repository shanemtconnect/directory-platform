import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { jobQueue, listings, profiles, user } from "@/lib/db/schema";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { SendResult } from "@/lib/email/sender";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();

vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { computeAwardsForYear, revokeAward } = await import("@/lib/db/queries/awards");
const { NOTIFY_AWARD_WON } = await import("@/lib/email/notify");
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

async function contest(tx: TestDb, ctx: ListingCtx, winnerPatch: Record<string, unknown>): Promise<string> {
  const winner = await makeListing(tx, ctx, { name: "Clear Winner", ratingAvg: "4.9", ratingCount: 7, ...winnerPatch });
  await makeListing(tx, ctx, { ratingAvg: "4.2", ratingCount: 6 });
  await makeListing(tx, ctx, { ratingAvg: "3.5", ratingCount: 9 });
  return winner;
}

async function adminViewer(tx: TestDb) {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Admin", email: `${userId}@example.test`, emailVerified: true });
  await tx.insert(profiles).values({ userId, role: "admin" });
  return { role: "admin" as const, userId };
}

describe("notify.award.won", () => {
  it("emails the owner's account address with the listing, the winners page and the badge kit", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const userId = `u_${randomUUID()}`;
      await tx.insert(user).values({ id: userId, name: "Owner", email: "owner@example.test", emailVerified: true });
      const [profile] = await tx.insert(profiles).values({ userId, role: "owner" }).returning({ id: profiles.id });
      await contest(tx, ctx, { ownerId: profile!.id, email: "listing@example.test" });

      const { created } = await computeAwardsForYear(tx, ADMIN_VIEWER, 2031);
      const queued = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_AWARD_WON));
      expect(queued.map((j) => j.payload)).toEqual([{ awardId: created[0]!.awardId }]);

      expect(await processNotifications(tx)).toBe(1);
      expect(sentTo()).toEqual(["owner@example.test"]);
      const text = bodies();
      expect(text).toContain("2031");
      expect(text).toContain("Clear Winner");
      expect(text).toMatch(/https:\/\/example\.co\.uk\/awards\/2031\/[a-z0-9-]+/);
      expect(text).toMatch(/https:\/\/example\.co\.uk\/[a-z0-9-]+\/clear-winner/);
      expect(text).toContain("https://example.co.uk/advertise/badge");
    });
  });

  it("falls back to a claimed listing's address, and sends nothing when there is none", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const winner = await contest(tx, ctx, { email: "listing@example.test", claimStatus: "claimed" });
      await computeAwardsForYear(tx, ADMIN_VIEWER, 2031);
      expect(await processNotifications(tx)).toBe(1);
      expect(sentTo()).toEqual(["listing@example.test"]);

      sendEmail.mockClear();
      await tx.update(listings).set({ email: null }).where(eq(listings.id, winner));
      await computeAwardsForYear(tx, ADMIN_VIEWER, 2032);
      // Completed, not parked: nobody to tell is not a failure to retry.
      expect(await processNotifications(tx)).toBe(1);
      expect(sentTo()).toEqual([]);
      const rows = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_AWARD_WON));
      expect(rows.every((r) => r.status === "done")).toBe(true);
    });
  });

  it("sends nothing to an unclaimed listing's contact address, and completes the job", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await contest(tx, ctx, { email: "listing@example.test", claimStatus: "unclaimed" });
      await computeAwardsForYear(tx, ADMIN_VIEWER, 2031);
      expect(await processNotifications(tx)).toBe(1);
      expect(sentTo()).toEqual([]);
      const rows = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_AWARD_WON));
      expect(rows.every((r) => r.status === "done")).toBe(true);
    });
  });

  it("sends nothing for an award revoked before the queue drained", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await contest(tx, ctx, { email: "listing@example.test" });
      const { created } = await computeAwardsForYear(tx, ADMIN_VIEWER, 2031);
      await revokeAward(tx, await adminViewer(tx), created[0]!.awardId, { reason: "bought", ip: null });

      expect(await processNotifications(tx)).toBe(1);
      expect(sentTo()).toEqual([]);
    });
  });
});
