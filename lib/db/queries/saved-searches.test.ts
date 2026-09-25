import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { makeViewer } from "@/test/admin-fixtures";
import { ensureProfile } from "@/lib/auth/profile";
import { resetClock, setClock } from "@/lib/clock";
import { auditLog, cities, jobs, savedSearches, user } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/db/queries/jobs";
import { NOTIFY_SAVED_SEARCH } from "@/lib/email/notify";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import {
  MAX_SAVED_SEARCHES,
  canonicalParams,
  createSavedSearch,
  deactivateSavedSearch,
  deleteSavedSearch,
  dueSavedSearches,
  listSavedSearches,
  markSavedSearchSent,
  newMatchesFor,
  paramsHash,
  savedSearchForDigest,
  setSavedSearchFrequency,
} from "./saved-searches";

const ADMIN: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

afterEach(() => resetClock());

async function person(tx: TestDb, verified = true) {
  const viewer = await makeViewer(tx, "user");
  await tx.update(user).set({ emailVerified: verified }).where(eq(user.id, viewer.userId));
  const profile = await ensureProfile(tx, viewer);
  return { viewer, profileId: profile.id, email: `${viewer.userId}@example.test` };
}

const save = (tx: TestDb, viewer: Viewer, params: Record<string, unknown>, kind: "listings" | "jobs" = "listings") =>
  createSavedSearch(tx, viewer, { kind, params, label: "A search" });

async function row(tx: TestDb, id: string) {
  const [r] = await tx.select().from(savedSearches).where(eq(savedSearches.id, id));
  return r!;
}

describe("canonicalParams / paramsHash", () => {
  it("ignores key order and empty values, so one search is one hash", () => {
    const a = { q: "barn", city: "leeds", fields: { capacity: "80", parking: "" }, category: "" };
    const b = { fields: { capacity: "80" }, city: "leeds", q: "barn", extra: null };
    expect(canonicalParams(a)).toBe('{"city":"leeds","fields":{"capacity":"80"},"q":"barn"}');
    expect(paramsHash(a)).toBe(paramsHash(b));
    expect(paramsHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(paramsHash({ q: "barn" })).not.toBe(paramsHash({ q: "hall" }));
  });
});

describe("createSavedSearch", () => {
  it("stores the canonical params, weekly by default, watermarked at the moment of saving", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-20T12:00:00Z"));
      const p = await person(tx);
      const result = await save(tx, p.viewer, { q: "barn", city: "" });
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      const r = await row(tx, result.id);
      expect(r.userId).toBe(p.profileId);
      expect(r.params).toEqual({ q: "barn" });
      expect(r.paramsHash).toBe(paramsHash({ q: "barn" }));
      expect(r.frequency).toBe("weekly");
      expect(r.isActive).toBe(true);
      expect(r.lastSentAt).toBeNull();
      expect(r.lastSeenPublishedAt).toEqual(new Date("2026-09-20T12:00:00Z"));
    });
  });

  it("dedupes by hash: the same search saved twice is one row, and saving it again re-activates it", async () => {
    await withTestDb(async (tx) => {
      const p = await person(tx);
      const first = await save(tx, p.viewer, { q: "barn", city: "leeds" });
      const again = await save(tx, p.viewer, { city: "leeds", q: "barn", category: "" });
      expect(first.outcome).toBe("created");
      expect(again.outcome).toBe("existing");
      if (first.outcome !== "created" || again.outcome !== "existing") return;
      expect(again.id).toBe(first.id);

      // Saving an ACTIVE search again leaves its watermark alone…
      const mark = new Date("2026-09-01T00:00:00Z");
      await tx.update(savedSearches).set({ lastSeenPublishedAt: mark }).where(eq(savedSearches.id, first.id));
      setClock(new Date("2026-09-25T10:00:00Z"));
      await save(tx, p.viewer, { q: "barn", city: "leeds" });
      expect((await row(tx, first.id)).lastSeenPublishedAt).toEqual(mark);
      // …but one switched off from an email starts again from now, not from months ago.
      await tx.update(savedSearches).set({ isActive: false }).where(eq(savedSearches.id, first.id));
      await save(tx, p.viewer, { q: "barn", city: "leeds" });
      const back = await row(tx, first.id);
      expect(back.isActive).toBe(true);
      expect(back.lastSeenPublishedAt).toEqual(new Date("2026-09-25T10:00:00Z"));

      // Same params, other kind: a different search.
      expect((await save(tx, p.viewer, { q: "barn", city: "leeds" }, "jobs")).outcome).toBe("created");
      // Same params, other person: theirs, not a duplicate.
      const other = await person(tx);
      expect((await save(tx, other.viewer, { q: "barn", city: "leeds" })).outcome).toBe("created");
    });
  });

  it(`caps a person at ${MAX_SAVED_SEARCHES}; a duplicate of one they have still answers`, async () => {
    await withTestDb(async (tx) => {
      const p = await person(tx);
      for (let i = 0; i < MAX_SAVED_SEARCHES; i++) {
        expect((await save(tx, p.viewer, { q: `term ${i}` })).outcome).toBe("created");
      }
      expect((await save(tx, p.viewer, { q: "one too many" })).outcome).toBe("limit");
      expect((await save(tx, p.viewer, { q: "term 3" })).outcome).toBe("existing");
      expect(await listSavedSearches(tx, p.viewer)).toHaveLength(MAX_SAVED_SEARCHES);
    });
  });

  it("refuses the public viewer", async () => {
    await withTestDb(async (tx) => {
      await expect(save(tx, PUBLIC_VIEWER, { q: "barn" })).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("list / delete / frequency", () => {
  it("scopes every read and write to the signed-in person", async () => {
    await withTestDb(async (tx) => {
      const a = await person(tx);
      const b = await person(tx);
      const created = await save(tx, a.viewer, { q: "barn" });
      if (created.outcome !== "created") throw new Error("expected a row");

      expect((await listSavedSearches(tx, a.viewer)).map((s) => s.id)).toEqual([created.id]);
      expect(await listSavedSearches(tx, b.viewer)).toEqual([]);

      expect(await setSavedSearchFrequency(tx, b.viewer, created.id, "daily")).toBe(false);
      expect(await deleteSavedSearch(tx, b.viewer, created.id)).toBe(false);
      expect(await setSavedSearchFrequency(tx, a.viewer, created.id, "daily")).toBe(true);
      expect((await row(tx, created.id)).frequency).toBe("daily");

      expect(await deleteSavedSearch(tx, a.viewer, "not-a-uuid")).toBe(false);
      expect(await deleteSavedSearch(tx, a.viewer, created.id)).toBe(true);
      expect(await listSavedSearches(tx, a.viewer)).toEqual([]);
    });
  });
});

describe("dueSavedSearches", () => {
  it("never sent is due; daily after 24 h, weekly after 7 d, less half an hour's tolerance; inactive, unverified and already-queued are not", async () => {
    await withTestDb(async (tx) => {
      const nowAt = new Date("2026-09-25T10:00:00Z");
      const p = await person(tx);
      const unverified = await person(tx, false);
      const id = async (viewer: Viewer, q: string, patch: Partial<typeof savedSearches.$inferInsert>) => {
        const r = await save(tx, viewer, { q });
        if (r.outcome !== "created") throw new Error("expected a row");
        if (Object.keys(patch).length > 0) await tx.update(savedSearches).set(patch).where(eq(savedSearches.id, r.id));
        return r.id;
      };
      const never = await id(p.viewer, "never", {});
      const dailyDue = await id(p.viewer, "daily due", { frequency: "daily", lastSentAt: new Date(nowAt.getTime() - DAY) });
      // A minute short of the period is due: the dispatch runs hourly, and a
      // digest stamped a few seconds after last :23 must not slip to :23 an hour later.
      const dailyAlmost = await id(p.viewer, "daily 23h59", { frequency: "daily", lastSentAt: new Date(nowAt.getTime() - DAY + 60_000) });
      await id(p.viewer, "daily early", { frequency: "daily", lastSentAt: new Date(nowAt.getTime() - DAY + HOUR) });
      const weeklyDue = await id(p.viewer, "weekly due", { frequency: "weekly", lastSentAt: new Date(nowAt.getTime() - 7 * DAY) });
      const weeklyAlmost = await id(p.viewer, "weekly 6d23h59", { frequency: "weekly", lastSentAt: new Date(nowAt.getTime() - 7 * DAY + 60_000) });
      await id(p.viewer, "weekly early", { frequency: "weekly", lastSentAt: new Date(nowAt.getTime() - 7 * DAY + HOUR) });
      await id(p.viewer, "inactive", { isActive: false });
      await id(unverified.viewer, "unverified", {});
      const queued = await id(p.viewer, "queued", {});
      await enqueueJob(tx, ADMIN, { kind: NOTIFY_SAVED_SEARCH, payload: { savedSearchId: queued } });

      const due = (await dueSavedSearches(tx, nowAt)).map((s) => s.id);
      const mine = new Set([never, dailyDue, dailyAlmost, weeklyDue, weeklyAlmost, queued]);
      expect(due.filter((d) => mine.has(d)).sort()).toEqual([never, dailyDue, dailyAlmost, weeklyDue, weeklyAlmost].sort());
      // Nothing else of this person's, whoever else shares the database.
      const all = await tx.select({ id: savedSearches.id }).from(savedSearches).where(eq(savedSearches.userId, p.profileId));
      const others = all.map((r) => r.id).filter((x) => !mine.has(x));
      expect(due.filter((d) => others.includes(d))).toEqual([]);
    });
  });
});

async function makeJob(tx: TestDb, ctx: ListingCtx, patch: Partial<typeof jobs.$inferInsert> = {}) {
  const id = randomUUID();
  await tx.insert(jobs).values({
    id, title: patch.title ?? `Job ${id.slice(0, 8)}`, description: "A description.", companyName: "Acme",
    cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, posterEmail: "p@example.co.uk",
    applyMethod: "email", applyEmail: "p@example.co.uk", status: "published", paymentStatus: "free",
    publishedAt: new Date("2026-09-24T00:00:00Z"), expiresAt: new Date("2026-12-01T00:00:00Z"), ...patch,
  });
  return id;
}

describe("newMatchesFor", () => {
  it("listings: only published rows created after `since`, newest first, through search()", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-25T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const since = new Date("2026-09-20T00:00:00Z");
      const tag = `zqx${randomUUID().slice(0, 6)}`;
      await makeListing(tx, ctx, { name: `${tag} old`, createdAt: new Date("2026-09-19T00:00:00Z") });
      // Submitted before the watermark, approved after it: new.
      const approved = await makeListing(tx, ctx, {
        name: `${tag} approved`, createdAt: new Date("2026-09-10T00:00:00Z"), publishedAt: new Date("2026-09-21T00:00:00Z"),
      });
      const a = await makeListing(tx, ctx, { name: `${tag} newer`, createdAt: new Date("2026-09-22T00:00:00Z") });
      const b = await makeListing(tx, ctx, { name: `${tag} newest`, createdAt: new Date("2026-09-23T00:00:00Z") });
      await makeListing(tx, ctx, { name: `${tag} pending`, status: "pending", createdAt: new Date("2026-09-23T00:00:00Z") });
      await makeListing(tx, ctx, { name: `${tag} removed`, status: "removed", createdAt: new Date("2026-09-23T00:00:00Z") });

      const matches = await newMatchesFor(tx, { kind: "listings", params: { q: tag } }, since);
      expect(matches.map((m) => m.id)).toEqual([b, a, approved]);
      expect(matches.total).toBe(3);
      expect(matches[0]).toMatchObject({ title: `${tag} newest`, liveAt: new Date("2026-09-23T00:00:00Z") });
      expect(matches[2]).toMatchObject({ liveAt: new Date("2026-09-21T00:00:00Z") });
      expect(matches[0]!.path).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);
    });
  });

  it("jobs: only open jobs created after `since`, through the board query", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-25T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const since = new Date("2026-09-20T00:00:00Z");
      const [city] = await tx.select({ slug: cities.slug }).from(cities).where(eq(cities.id, ctx.cityId));
      const d = (day: number) => new Date(`2026-09-${day}T00:00:00Z`);
      await makeJob(tx, ctx, { title: "Old", createdAt: d(18), publishedAt: d(19) });
      // Posted before the watermark, approved after it — the usual path for a job.
      const fresh = await makeJob(tx, ctx, { title: "Fresh", createdAt: d(18), publishedAt: d(22) });
      await makeJob(tx, ctx, { title: "Pending", status: "pending", createdAt: d(22), publishedAt: null });

      const matches = await newMatchesFor(tx, { kind: "jobs", params: { citySlug: city!.slug } }, since);
      expect(matches.map((m) => m.id)).toEqual([fresh]);
      expect(matches.total).toBe(1);
      expect(matches[0]).toMatchObject({ title: "Fresh", path: `/jobs/${fresh}` });
    });
  });
});

describe("the worker's reads and writes", () => {
  it("reads a search with its owner's address only while active and verified, and marks it sent", async () => {
    await withTestDb(async (tx) => {
      const p = await person(tx);
      const created = await save(tx, p.viewer, { q: "barn" });
      if (created.outcome !== "created") throw new Error("expected a row");

      await expect(savedSearchForDigest(tx, p.viewer, created.id)).rejects.toThrow("FORBIDDEN");
      const d = await savedSearchForDigest(tx, ADMIN, created.id);
      expect(d?.email).toBe(p.email);
      expect(d?.search.id).toBe(created.id);

      const sentAt = new Date("2026-09-25T10:00:00Z");
      const watermark = new Date("2026-09-24T09:00:00Z");
      await markSavedSearchSent(tx, ADMIN, created.id, { sentAt, lastSeenPublishedAt: watermark });
      const r = await row(tx, created.id);
      expect(r.lastSentAt).toEqual(sentAt);
      expect(r.lastSeenPublishedAt).toEqual(watermark);

      await tx.update(user).set({ emailVerified: false }).where(eq(user.id, p.viewer.userId));
      expect(await savedSearchForDigest(tx, ADMIN, created.id)).toBeNull();
    });
  });

  it("deactivates on the unsubscribe claim, once, with an audit row", async () => {
    await withTestDb(async (tx) => {
      const p = await person(tx);
      const created = await save(tx, p.viewer, { q: "barn" });
      if (created.outcome !== "created") throw new Error("expected a row");

      // The token's address must still be the owner's: an old address after an email change cannot.
      expect(await deactivateSavedSearch(tx, PUBLIC_VIEWER, created.id, "someone-else@example.test", null)).toBe(false);
      expect((await row(tx, created.id)).isActive).toBe(true);
      expect(await deactivateSavedSearch(tx, PUBLIC_VIEWER, created.id, ` ${p.email.toUpperCase()} `, "203.0.113.9")).toBe(true);
      expect((await row(tx, created.id)).isActive).toBe(false);
      expect(await deactivateSavedSearch(tx, PUBLIC_VIEWER, created.id, p.email, "203.0.113.9")).toBe(false);
      expect(await deactivateSavedSearch(tx, PUBLIC_VIEWER, "not-a-uuid", p.email, null)).toBe(false);
      expect(await savedSearchForDigest(tx, ADMIN, created.id)).toBeNull();

      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, created.id));
      expect(audits.map((a) => a.action)).toEqual(["saved_search.unsubscribed"]);
    });
  });
});
