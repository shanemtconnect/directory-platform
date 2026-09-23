import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { listingStatsDaily, listings, profiles, user } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { resetClock, setClock } from "@/lib/clock";
import { siteConfig } from "@/config/site.config";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { applyStatDeltas, listingStats, purgeStatsBefore } from "./stats";

const TODAY = new Date("2026-09-12T10:00:00Z");

afterEach(resetClock);

/** A Better Auth user and the profile row every "who" column references. */
async function makeOwner(tx: TestDb): Promise<{ userId: string; profileId: string }> {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
  const [row] = await tx.insert(profiles).values({ userId }).returning({ id: profiles.id });
  return { userId, profileId: row!.id };
}

async function seedDay(
  tx: TestDb, listingId: string, day: string, patch: Partial<typeof listingStatsDaily.$inferInsert>,
): Promise<void> {
  await tx.insert(listingStatsDaily).values({ listingId, day, ...patch });
}

describe("listingStats — who may read it", () => {
  it("returns null for the public viewer", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      expect(await listingStats(tx, PUBLIC_VIEWER, listingId, 30)).toBeNull();
    });
  });

  it("returns null for a signed-in user who does not own the listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const stranger = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: owner.profileId });

      const viewer: Viewer = { role: "owner", userId: stranger.userId };
      expect(await listingStats(tx, viewer, listingId, 30)).toBeNull();
    });
  });

  it("returns null for an unowned listing even to a signed-in user", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const someone = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: null });

      const viewer: Viewer = { role: "user", userId: someone.userId };
      expect(await listingStats(tx, viewer, listingId, 30)).toBeNull();
    });
  });

  it("returns the stats to the owner", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: owner.profileId, name: "The Old Mill" });

      const viewer: Viewer = { role: "user", userId: owner.userId };
      const stats = await listingStats(tx, viewer, listingId, 30);

      expect(stats?.listingId).toBe(listingId);
      expect(stats?.listingName).toBe("The Old Mill");
    });
  });

  it("returns the stats to an admin who does not own the listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const staff = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: owner.profileId });

      const viewer: Viewer = { role: "admin", userId: staff.userId };
      expect(await listingStats(tx, viewer, listingId, 30)).not.toBeNull();
    });
  });

  it("returns null for an unknown or malformed listing id", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeOwner(tx);
      const viewer: Viewer = { role: "admin", userId: owner.userId };

      expect(await listingStats(tx, viewer, randomUUID(), 30)).toBeNull();
      expect(await listingStats(tx, viewer, "'; drop table listings; --", 30)).toBeNull();
    });
  });

  it("shows an owner their own unpublished listing", async () => {
    // Deliberately NOT behind publishedListings(): an owner whose listing is
    // pending or archived still paid for the months it was live, and hiding the
    // history is how a renewal conversation gets argued from nothing.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: owner.profileId, status: "archived" });

      const viewer: Viewer = { role: "owner", userId: owner.userId };
      expect(await listingStats(tx, viewer, listingId, 30)).not.toBeNull();
    });
  });
});

describe("listingStats — the window", () => {
  it("caps the window at the tier's statsWindowDays and says so", async () => {
    await withTestDb(async (tx) => {
      setClock(TODAY);
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: owner.profileId, tier: "free" });
      const viewer: Viewer = { role: "owner", userId: owner.userId };

      const stats = await listingStats(tx, viewer, listingId, 365);

      expect(stats?.capDays).toBe(siteConfig.tiers.free.statsWindowDays);
      expect(stats?.requestedDays).toBe(365);
      expect(stats?.windowDays).toBe(siteConfig.tiers.free.statsWindowDays);
      expect(stats?.capped).toBe(true);
      expect(stats?.days).toHaveLength(siteConfig.tiers.free.statsWindowDays);
    });
  });

  it("leaves a window inside the cap alone", async () => {
    await withTestDb(async (tx) => {
      setClock(TODAY);
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: owner.profileId, tier: "premium" });
      const viewer: Viewer = { role: "owner", userId: owner.userId };

      const stats = await listingStats(tx, viewer, listingId, 90);

      expect(stats?.windowDays).toBe(90);
      expect(stats?.capped).toBe(false);
      expect(stats?.days).toHaveLength(90);
    });
  });

  it("a higher tier sees further back", async () => {
    await withTestDb(async (tx) => {
      setClock(TODAY);
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const viewer: Viewer = { role: "owner", userId: owner.userId };
      const free = await makeListing(tx, ctx, { ownerId: owner.profileId, tier: "free" });
      const paid = await makeListing(tx, ctx, { ownerId: owner.profileId, tier: "premium" });

      expect((await listingStats(tx, viewer, free, 365))!.windowDays)
        .toBeLessThan((await listingStats(tx, viewer, paid, 365))!.windowDays);
    });
  });

  it("refuses a nonsense window rather than scanning the table", async () => {
    await withTestDb(async (tx) => {
      setClock(TODAY);
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: owner.profileId, tier: "premium" });
      const viewer: Viewer = { role: "owner", userId: owner.userId };

      expect((await listingStats(tx, viewer, listingId, 0))!.windowDays).toBe(1);
      expect((await listingStats(tx, viewer, listingId, -5))!.windowDays).toBe(1);
      expect((await listingStats(tx, viewer, listingId, Number.NaN))!.windowDays).toBe(1);
      expect((await listingStats(tx, viewer, listingId, 10_000))!.windowDays)
        .toBe(siteConfig.tiers.premium.statsWindowDays);
    });
  });
});

describe("listingStats — the rows", () => {
  it("zero-fills every day in the window, oldest first, ending today", async () => {
    await withTestDb(async (tx) => {
      setClock(TODAY);
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: owner.profileId });
      await seedDay(tx, listingId, "2026-09-11", { views: 4 });
      const viewer: Viewer = { role: "owner", userId: owner.userId };

      const stats = await listingStats(tx, viewer, listingId, 3);

      expect(stats!.days.map((d) => d.day)).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"]);
      expect(stats!.days.map((d) => d.views)).toEqual([0, 4, 0]);
    });
  });

  it("totals every metric across the window", async () => {
    await withTestDb(async (tx) => {
      setClock(TODAY);
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: owner.profileId });
      await seedDay(tx, listingId, "2026-09-11",
        { views: 4, impressions: 40, enquiries: 1, shortlistAdds: 2, badgeClicks: 3, quoteRequests: 0 });
      await seedDay(tx, listingId, "2026-09-12",
        { views: 6, impressions: 60, enquiries: 2, shortlistAdds: 1, badgeClicks: 0, quoteRequests: 0 });
      const viewer: Viewer = { role: "owner", userId: owner.userId };

      const stats = await listingStats(tx, viewer, listingId, 7);

      expect(stats!.totals).toEqual({
        views: 10, impressions: 100, enquiries: 3, shortlistAdds: 3, badgeClicks: 3, quoteRequests: 0,
      });
    });
  });

  it("excludes days outside the window", async () => {
    await withTestDb(async (tx) => {
      setClock(TODAY);
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: owner.profileId });
      await seedDay(tx, listingId, "2026-09-01", { views: 999 });
      const viewer: Viewer = { role: "owner", userId: owner.userId };

      const stats = await listingStats(tx, viewer, listingId, 3);

      expect(stats!.totals.views).toBe(0);
      expect(stats!.days.some((d) => d.day === "2026-09-01")).toBe(false);
    });
  });

  it("never mixes in another listing's rows", async () => {
    await withTestDb(async (tx) => {
      setClock(TODAY);
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const mine = await makeListing(tx, ctx, { ownerId: owner.profileId });
      const theirs = await makeListing(tx, ctx, { ownerId: owner.profileId });
      await seedDay(tx, theirs, "2026-09-12", { views: 99 });
      const viewer: Viewer = { role: "owner", userId: owner.userId };

      expect((await listingStats(tx, viewer, mine, 7))!.totals.views).toBe(0);
    });
  });
});

describe("applyStatDeltas — who may write it", () => {
  it("refuses a public viewer rather than writing the batch", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      await expect(applyStatDeltas(tx, PUBLIC_VIEWER, [{
        listingId, day: "2026-09-12",
        views: 1, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0, quoteRequests: 0,
      }])).rejects.toThrow("FORBIDDEN");

      expect(await tx.select().from(listingStatsDaily)
        .where(eq(listingStatsDaily.listingId, listingId))).toHaveLength(0);
    });
  });

  it("refuses a signed-in owner too — this is the worker's write, not theirs", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeOwner(tx);
      const viewer: Viewer = { role: "owner", userId: owner.userId };

      await expect(applyStatDeltas(tx, viewer, [])).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("applyStatDeltas", () => {
  it("inserts a new day's counts", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      const written = await applyStatDeltas(tx, ADMIN_VIEWER, [{
        listingId, day: "2026-09-12",
        views: 3, impressions: 30, enquiries: 1, shortlistAdds: 2, badgeClicks: 0, quoteRequests: 0,
      }]);

      expect(written).toBe(1);
      const [row] = await tx.select().from(listingStatsDaily)
        .where(eq(listingStatsDaily.listingId, listingId));
      expect(row).toMatchObject({ day: "2026-09-12", views: 3, impressions: 30, enquiries: 1 });
    });
  });

  it("adds to an existing day rather than replacing it", async () => {
    // The flush runs every five minutes: the second flush of a day must not
    // reset the first four minutes' views to the last five minutes' views.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const delta = {
        listingId, day: "2026-09-12",
        views: 3, impressions: 30, enquiries: 1, shortlistAdds: 0, badgeClicks: 0, quoteRequests: 0,
      };

      await applyStatDeltas(tx, ADMIN_VIEWER, [delta]);
      await applyStatDeltas(tx, ADMIN_VIEWER, [delta]);

      const [row] = await tx.select().from(listingStatsDaily)
        .where(eq(listingStatsDaily.listingId, listingId));
      expect(row).toMatchObject({ views: 6, impressions: 60, enquiries: 2 });
    });
  });

  it("drops a delta for a listing that no longer exists instead of failing the batch", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      const written = await applyStatDeltas(tx, ADMIN_VIEWER, [
        { listingId: randomUUID(), day: "2026-09-12", views: 1, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0, quoteRequests: 0 },
        { listingId, day: "2026-09-12", views: 1, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0, quoteRequests: 0 },
      ]);

      expect(written).toBe(1);
      const rows = await tx.select().from(listingStatsDaily)
        .where(eq(listingStatsDaily.listingId, listingId));
      expect(rows).toHaveLength(1);
    });
  });

  it("drops a delta for a listing that is not published instead of counting it", async () => {
    // The beacon takes any uuid. A pending, rejected or archived listing has no
    // public page to be viewed from, so a view against it is either a stale
    // cache or a forgery — and either way not a number its owner should be
    // asked to renew on.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const live = await makeListing(tx, ctx);
      const archived = await makeListing(tx, ctx, { status: "archived" });
      const pending = await makeListing(tx, ctx, { status: "pending" });
      const delta = { day: "2026-09-12", views: 1, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0, quoteRequests: 0 };

      const written = await applyStatDeltas(tx, ADMIN_VIEWER, [
        { listingId: archived, ...delta },
        { listingId: pending, ...delta },
        { listingId: live, ...delta },
      ]);

      expect(written).toBe(1);
      const rows = await tx.select({ listingId: listingStatsDaily.listingId }).from(listingStatsDaily);
      expect(rows).toEqual([{ listingId: live }]);
    });
  });

  it("is a no-op for an empty batch", async () => {
    await withTestDb(async (tx) => {
      expect(await applyStatDeltas(tx, ADMIN_VIEWER, [])).toBe(0);
    });
  });

  it("ignores a delta whose counts are all zero", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      const written = await applyStatDeltas(tx, ADMIN_VIEWER, [{
        listingId, day: "2026-09-12",
        views: 0, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0, quoteRequests: 0,
      }]);

      expect(written).toBe(0);
      expect(await tx.select().from(listingStatsDaily)
        .where(eq(listingStatsDaily.listingId, listingId))).toHaveLength(0);
    });
  });

  it("refuses a malformed listing id or day rather than putting it in the statement", async () => {
    await withTestDb(async (tx) => {
      const written = await applyStatDeltas(tx, ADMIN_VIEWER, [
        { listingId: "1); drop table listings; --", day: "2026-09-12", views: 1, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0, quoteRequests: 0 },
        { listingId: randomUUID(), day: "not-a-day", views: 1, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0, quoteRequests: 0 },
      ]);

      expect(written).toBe(0);
    });
  });
});

describe("applyStatDeltas — listings.view_count", () => {
  const zero = { impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0, quoteRequests: 0 };

  async function viewCount(tx: TestDb, listingId: string): Promise<number> {
    const [row] = await tx.select({ n: listings.viewCount }).from(listings)
      .where(eq(listings.id, listingId));
    return row!.n;
  }

  it("adds the batch's views to the listing's lifetime total", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { viewCount: 10 });

      await applyStatDeltas(tx, ADMIN_VIEWER, [{ listingId, day: "2026-09-12", views: 3, ...zero }]);
      await applyStatDeltas(tx, ADMIN_VIEWER, [{ listingId, day: "2026-09-12", views: 2, ...zero }]);

      expect(await viewCount(tx, listingId)).toBe(15);
    });
  });

  it("sums every day in one batch into one lifetime total", async () => {
    // A flush that straddles midnight hands over two days for one listing;
    // the total is the sum, applied once, not the last day's number.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      await applyStatDeltas(tx, ADMIN_VIEWER, [
        { listingId, day: "2026-09-11", views: 4, ...zero },
        { listingId, day: "2026-09-12", views: 5, ...zero },
      ]);

      expect(await viewCount(tx, listingId)).toBe(9);
    });
  });

  it("counts views only — impressions, enquiries and saves are not views", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      await applyStatDeltas(tx, ADMIN_VIEWER, [{
        listingId, day: "2026-09-12",
        views: 0, impressions: 40, enquiries: 2, shortlistAdds: 3, badgeClicks: 1, quoteRequests: 0,
      }]);

      expect(await viewCount(tx, listingId)).toBe(0);
    });
  });

  it("leaves an unpublished listing's total alone, like the daily row", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const archived = await makeListing(tx, ctx, { status: "archived", viewCount: 7 });

      await applyStatDeltas(tx, ADMIN_VIEWER, [{ listingId: archived, day: "2026-09-12", views: 3, ...zero }]);

      expect(await viewCount(tx, archived)).toBe(7);
    });
  });

  it("touches only the listings in the batch", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeListing(tx, ctx);
      const b = await makeListing(tx, ctx, { viewCount: 1 });

      await applyStatDeltas(tx, ADMIN_VIEWER, [{ listingId: a, day: "2026-09-12", views: 3, ...zero }]);

      expect(await viewCount(tx, a)).toBe(3);
      expect(await viewCount(tx, b)).toBe(1);
    });
  });
});

describe("purgeStatsBefore", () => {
  it("refuses a public viewer and an owner — the worker's write, not theirs", async () => {
    await withTestDb(async (tx) => {
      await expect(purgeStatsBefore(tx, PUBLIC_VIEWER, "2026-01-01")).rejects.toThrow("FORBIDDEN");
      const owner: Viewer = { role: "owner", userId: "u_x" };
      await expect(purgeStatsBefore(tx, owner, "2026-01-01")).rejects.toThrow("FORBIDDEN");
    });
  });

  it("deletes rows before the cutoff day and keeps the cutoff day itself", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeListing(tx, ctx);
      const b = await makeListing(tx, ctx);
      await seedDay(tx, a, "2025-08-01", { views: 1 });
      await seedDay(tx, a, "2025-08-02", { views: 1 });
      await seedDay(tx, a, "2025-08-03", { views: 1 });
      await seedDay(tx, b, "2025-07-31", { views: 1 });

      expect(await purgeStatsBefore(tx, ADMIN_VIEWER, "2025-08-02")).toBe(2);

      const left = (await tx.select({ day: listingStatsDaily.day }).from(listingStatsDaily))
        .map((r) => r.day).sort();
      expect(left).toEqual(["2025-08-02", "2025-08-03"]);
    });
  });

  it("refuses a malformed cutoff rather than putting it in the statement", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeListing(tx, ctx);
      await seedDay(tx, a, "2025-08-01", { views: 1 });

      await expect(purgeStatsBefore(tx, ADMIN_VIEWER, "2999-99-99' or true --")).rejects.toThrow();
      expect(await tx.select().from(listingStatsDaily)).toHaveLength(1);
    });
  });
});
