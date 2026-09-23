import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { cities, claims, removalRequests, reports, reviews } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeViewer } from "@/test/admin-fixtures";
import { makeScaffold, makeListing } from "@/test/factories";
import { adminQueueCounts, adminQueueCountsInOneQuery } from "./dashboard";

describe("adminQueueCounts", () => {
  it("counts only the work that is still open", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const live = await makeListing(tx, ctx, { name: "Live" });
      await makeListing(tx, ctx, { name: "Waiting", status: "pending" });
      await makeListing(tx, ctx, { name: "Turned Down", status: "rejected" });

      await tx.insert(reports).values([
        { listingId: live, reason: "incorrect" },
        { listingId: live, reason: "closed", status: "dismissed" },
      ]);
      await tx.insert(removalRequests).values([
        { listingId: live },
        { listingId: live, status: "actioned" },
      ]);
      await tx.insert(claims).values([
        { listingId: live },
        { listingId: live, status: "approved" },
      ]);
      await tx.insert(reviews).values([
        // Verified and held: waiting for a moderator.
        { listingId: live, authorEmail: "a@example.test", rating: 4,
          emailVerifiedAt: new Date(), flaggedReason: "too-short" },
        // Never verified: not anybody's work.
        { listingId: live, authorEmail: "b@example.test", rating: 4 },
        // Decided.
        { listingId: live, authorEmail: "c@example.test", rating: 4,
          emailVerifiedAt: new Date(), status: "published" },
      ]);

      const counts = await adminQueueCounts(tx, admin);
      expect(counts.pendingSubmissions).toBe(1);
      expect(counts.openReports).toBe(1);
      expect(counts.openRemovals).toBe(1);
      expect(counts.pendingClaims).toBe(1);
      expect(counts.reviewsAwaitingModeration).toBe(1);
      // The scaffold's city is published and has no intro copy.
      expect(counts.citiesAwaitingIntro).toBeGreaterThanOrEqual(1);
    });
  });

  it("does not count an unpublished city as waiting for copy", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);

      const before = (await adminQueueCounts(tx, admin)).citiesAwaitingIntro;
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, ctx.cityId));
      const after = (await adminQueueCounts(tx, admin)).citiesAwaitingIntro;

      expect(after).toBe(before - 1);
    });
  });

  it("refuses anyone who is not an admin", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeViewer(tx, "owner");
      await expect(adminQueueCounts(tx, owner)).rejects.toThrow("FORBIDDEN");
      await expect(adminQueueCounts(tx, PUBLIC_VIEWER)).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("adminQueueCountsInOneQuery", () => {
  /** Counts every statement the handle is asked to run. */
  function counting<T extends object>(tx: T): { tx: T; calls: () => number } {
    let n = 0;
    const proxy = new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop === "select" || prop === "execute" || prop === "insert" || prop === "update" || prop === "delete") n++;
        return Reflect.get(target, prop, receiver);
      },
    });
    return { tx: proxy, calls: () => n };
  }

  it("returns the same six numbers as the sequential version, in one statement", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const live = await makeListing(tx, ctx, { name: "Live" });
      await makeListing(tx, ctx, { name: "Waiting", status: "pending" });
      await tx.insert(reports).values([{ listingId: live, reason: "incorrect" }]);
      await tx.insert(removalRequests).values([{ listingId: live }, { listingId: live, status: "actioned" }]);
      await tx.insert(claims).values([{ listingId: live }, { listingId: live, status: "approved" }]);
      await tx.insert(reviews).values([
        { listingId: live, authorEmail: "a@example.test", rating: 4,
          emailVerifiedAt: new Date(), flaggedReason: "too-short" },
        { listingId: live, authorEmail: "b@example.test", rating: 4 },
      ]);

      const expected = await adminQueueCounts(tx, admin);
      const { tx: watched, calls } = counting(tx);
      const actual = await adminQueueCountsInOneQuery(watched, admin);

      expect(actual).toEqual(expected);
      expect(actual.pendingSubmissions).toBe(1);
      expect(actual.reviewsAwaitingModeration).toBe(1);
      expect(calls()).toBe(1);
    });
  });

  it("refuses anyone who is not an admin", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeViewer(tx, "owner");
      await expect(adminQueueCountsInOneQuery(tx, owner)).rejects.toThrow("FORBIDDEN");
    });
  });
});
