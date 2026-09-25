import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { makeViewer } from "@/test/admin-fixtures";
import { FEATURE_FLAGS } from "@/config/types";
import { jobQueue, listings, savedSearches, user } from "@/lib/db/schema";
import { resetClock, setClock } from "@/lib/clock";
import type { SendResult } from "@/lib/email/sender";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();
vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));
// Every flag on: the digest is only sent on a site with the module.
vi.mock("@/lib/features/flags", () => {
  const map = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, true]));
  return { features: map, isEnabled: (f: string) => map[f] };
});

const { NOTIFY_SAVED_SEARCH } = await import("@/lib/email/notify");
const { enqueueJob } = await import("@/lib/db/queries/jobs");
const { createSavedSearch } = await import("@/lib/db/queries/saved-searches");
const { verifyUnsubscribe } = await import("@/lib/email/unsubscribe");
const { ADMIN_VIEWER } = await import("@/worker/viewer");
const { processNotifications } = await import("./notify");

const ENV = { ...process.env };
beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ sent: true, id: "eml_1" });
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "unit-test-secret";
});
afterEach(() => {
  process.env = { ...ENV };
  resetClock();
});

/** A verified person with one saved search, saved at `savedAt`, and a tag only this test's listings carry. */
async function setup(tx: TestDb, savedAt: Date) {
  const viewer = await makeViewer(tx, "user");
  await tx.update(user).set({ emailVerified: true }).where(eq(user.id, viewer.userId));
  const tag = `zqa${Math.random().toString(36).slice(2, 8)}`;
  setClock(savedAt);
  const created = await createSavedSearch(tx, viewer, { kind: "listings", params: { q: tag }, label: "My search" });
  if (created.outcome !== "created") throw new Error("expected a row");
  return { viewer, tag, id: created.id, email: `${viewer.userId}@example.test` };
}

/** Queue as the dispatch would at `dispatchedAt`, drain, and hand back the job row. */
async function run(tx: TestDb, id: string, dispatchedAt = new Date("2026-09-25T09:23:00Z")) {
  await tx.delete(jobQueue).where(eq(jobQueue.kind, NOTIFY_SAVED_SEARCH));
  // Due from the epoch: the claim compares run_after with the (frozen) test clock.
  await enqueueJob(tx, ADMIN_VIEWER, {
    kind: NOTIFY_SAVED_SEARCH,
    payload: { savedSearchId: id, dispatchedAt: dispatchedAt.toISOString() },
    runAfter: new Date(0),
  });
  await processNotifications(tx);
  const [job] = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_SAVED_SEARCH));
  return job!;
}

describe("notify.saved_search", () => {
  it("sends the new matches with an unsubscribe link, then moves the watermark and stamps last_sent_at with the dispatch time", async () => {
    await withTestDb(async (tx) => {
      const s = await setup(tx, new Date("2026-09-20T00:00:00Z"));
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: `${s.tag} before`, createdAt: new Date("2026-09-19T00:00:00Z") });
      await makeListing(tx, ctx, { name: `${s.tag} one`, createdAt: new Date("2026-09-21T00:00:00Z") });
      await makeListing(tx, ctx, { name: `${s.tag} two`, createdAt: new Date("2026-09-22T00:00:00Z") });
      await makeListing(tx, ctx, { name: `${s.tag} unpublished`, status: "pending", createdAt: new Date("2026-09-22T00:00:00Z") });

      // Drained well after the tick that queued it.
      setClock(new Date("2026-09-25T10:00:00Z"));
      const job = await run(tx, s.id, new Date("2026-09-25T09:23:00Z"));
      expect(job.status).toBe("done");

      expect(sendEmail).toHaveBeenCalledTimes(1);
      const msg = sendEmail.mock.calls[0]![0] as { to: string; subject: string; text: string };
      expect(msg.to).toBe(s.email);
      expect(msg.subject).toMatch(/^2 new /);
      expect(msg.text).toContain(`${s.tag} one`);
      expect(msg.text).toContain(`${s.tag} two`);
      expect(msg.text).not.toContain(`${s.tag} before`);
      expect(msg.text).not.toContain(`${s.tag} unpublished`);
      const token = /\/unsubscribe\?t=([^\s]+)/.exec(msg.text)?.[1];
      expect(verifyUnsubscribe(decodeURIComponent(token!))).toEqual({ savedSearchId: s.id, email: s.email });

      const [row] = await tx.select().from(savedSearches).where(eq(savedSearches.id, s.id));
      // The dispatch tick, not the drain: the cadence must not slip by the queue's lag.
      expect(row!.lastSentAt).toEqual(new Date("2026-09-25T09:23:00Z"));
      expect(row!.lastSeenPublishedAt).toEqual(new Date("2026-09-22T00:00:00Z"));
    });
  });

  it("a row created before the watermark and published after it appears in the next digest", async () => {
    await withTestDb(async (tx) => {
      const s = await setup(tx, new Date("2026-09-20T00:00:00Z"));
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: `${s.tag} first`, createdAt: new Date("2026-09-22T00:00:00Z") });
      // Submitted on the 21st and still waiting for a moderator when the first digest goes.
      const late = await makeListing(tx, ctx, {
        name: `${s.tag} moderated`, status: "pending", createdAt: new Date("2026-09-21T00:00:00Z"),
      });

      setClock(new Date("2026-09-23T10:00:00Z"));
      expect((await run(tx, s.id, new Date("2026-09-23T09:23:00Z"))).status).toBe("done");
      expect((sendEmail.mock.calls[0]![0] as { text: string }).text).not.toContain(`${s.tag} moderated`);

      // Approved on the 24th — after the watermark (the 22nd) had moved past its creation.
      await tx.update(listings).set({ status: "published", publishedAt: new Date("2026-09-24T08:00:00Z") })
        .where(eq(listings.id, late));

      setClock(new Date("2026-09-24T10:00:00Z"));
      expect((await run(tx, s.id, new Date("2026-09-24T09:23:00Z"))).status).toBe("done");
      expect(sendEmail).toHaveBeenCalledTimes(2);
      const second = sendEmail.mock.calls[1]![0] as { subject: string; text: string };
      expect(second.subject).toMatch(/^1 new /);
      expect(second.text).toContain(`${s.tag} moderated`);
      expect(second.text).not.toContain(`${s.tag} first`);
      const [row] = await tx.select().from(savedSearches).where(eq(savedSearches.id, s.id));
      expect(row!.lastSeenPublishedAt).toEqual(new Date("2026-09-24T08:00:00Z"));
    });
  });

  it("sends nothing and changes nothing when the matches have gone by send time, or the search is off", async () => {
    await withTestDb(async (tx) => {
      const s = await setup(tx, new Date("2026-09-20T00:00:00Z"));
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: `${s.tag} withdrawn`, status: "removed", createdAt: new Date("2026-09-21T00:00:00Z") });

      expect((await run(tx, s.id)).status).toBe("done");

      await makeListing(tx, ctx, { name: `${s.tag} live`, createdAt: new Date("2026-09-21T00:00:00Z") });
      await tx.update(savedSearches).set({ isActive: false }).where(eq(savedSearches.id, s.id));
      expect((await run(tx, s.id)).status).toBe("done");

      expect(sendEmail).not.toHaveBeenCalled();
      const [row] = await tx.select().from(savedSearches).where(eq(savedSearches.id, s.id));
      expect(row!.lastSentAt).toBeNull();
    });
  });
});
