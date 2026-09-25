import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { makeViewer } from "@/test/admin-fixtures";
import { jobQueue, jobs, savedSearches, user } from "@/lib/db/schema";
import { resetClock, setClock } from "@/lib/clock";
import { createSavedSearch } from "@/lib/db/queries/saved-searches";
import { NOTIFY_SAVED_SEARCH } from "@/lib/email/notify";
import { dispatchAlerts } from "./alerts";

const ON = { savedSearches: true, jobBoard: true };
const AT = new Date("2026-09-25T10:00:00Z");

afterEach(() => resetClock());

async function saved(tx: TestDb, kind: "listings" | "jobs", params: Record<string, unknown>) {
  const viewer = await makeViewer(tx, "user");
  await tx.update(user).set({ emailVerified: true }).where(eq(user.id, viewer.userId));
  setClock(new Date("2026-09-20T00:00:00Z"));
  const r = await createSavedSearch(tx, viewer, { kind, params, label: "x" });
  if (r.outcome !== "created") throw new Error("expected a row");
  resetClock();
  return r.id;
}

const queuedFor = async (tx: TestDb, id: string) =>
  (await tx.select({ id: jobQueue.id }).from(jobQueue).where(and(
    eq(jobQueue.kind, NOTIFY_SAVED_SEARCH),
    sql`${jobQueue.payload} ->> 'savedSearchId' = ${id}`,
  ))).length;

describe("dispatchAlerts", () => {
  it("queues one digest per due search with something new, and none for one with nothing new", async () => {
    await withTestDb(async (tx) => {
      const tag = `zqd${Math.random().toString(36).slice(2, 8)}`;
      const withNew = await saved(tx, "listings", { q: tag });
      const nothingNew = await saved(tx, "listings", { q: `${tag}-none` });
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: `${tag} fresh`, createdAt: new Date("2026-09-21T00:00:00Z") });

      await dispatchAlerts(tx, AT, ON);
      expect(await queuedFor(tx, withNew)).toBe(1);
      expect(await queuedFor(tx, nothingNew)).toBe(0);
      // The tick's own time rides in the payload, to stamp last_sent_at with.
      const [job] = await tx.select({ payload: jobQueue.payload }).from(jobQueue).where(and(
        eq(jobQueue.kind, NOTIFY_SAVED_SEARCH), sql`${jobQueue.payload} ->> 'savedSearchId' = ${withNew}`,
      ));
      expect(job!.payload).toEqual({ savedSearchId: withNew, dispatchedAt: AT.toISOString() });

      // A second tick before the worker drains it does not double up.
      await dispatchAlerts(tx, AT, ON);
      expect(await queuedFor(tx, withNew)).toBe(1);
    });
  });

  it("is a no-op with the flag off, and skips jobs searches while the board is off", async () => {
    await withTestDb(async (tx) => {
      const jobsSearch = await saved(tx, "jobs", {});
      const tag = `zqe${Math.random().toString(36).slice(2, 8)}`;
      const listingsSearch = await saved(tx, "listings", { q: tag });
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: `${tag} fresh`, createdAt: new Date("2026-09-21T00:00:00Z") });
      // A new open job, so only the flag can stop the jobs search.
      await tx.insert(jobs).values({
        title: "Fresh job", description: "A description.", cityId: ctx.cityId, categoryId: ctx.primaryCategoryId,
        posterEmail: "p@example.co.uk", applyMethod: "email", applyEmail: "p@example.co.uk",
        status: "published", paymentStatus: "free", createdAt: new Date("2026-09-21T00:00:00Z"),
        publishedAt: new Date("2026-09-21T00:00:00Z"), expiresAt: new Date(Date.now() + 30 * 86_400_000),
      });

      expect(await dispatchAlerts(tx, AT, { savedSearches: false, jobBoard: true })).toEqual({ checked: 0, queued: 0 });
      expect(await queuedFor(tx, listingsSearch)).toBe(0);

      await dispatchAlerts(tx, AT, { savedSearches: true, jobBoard: false });
      expect(await queuedFor(tx, listingsSearch)).toBe(1);
      expect(await queuedFor(tx, jobsSearch)).toBe(0);
      const [row] = await tx.select().from(savedSearches).where(eq(savedSearches.id, jobsSearch));
      expect(row!.isActive).toBe(true);

      // The board back on: its alerts come back.
      await dispatchAlerts(tx, AT, ON);
      expect(await queuedFor(tx, jobsSearch)).toBe(1);
    });
  });
});
