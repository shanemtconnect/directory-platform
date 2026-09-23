import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { makeScaffold, makeListing, makeCity, makeCategoryInCity, type ListingCtx } from "@/test/factories";
import { auditLog, awards, jobQueue, listings, profiles, user } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { setClock, resetClock } from "@/lib/clock";
import { NOTIFY_AWARD_WON } from "@/lib/email/notify";
import {
  AWARDS_MIN_RATED_LISTINGS,
  DEFAULT_AWARDS_MIN_REVIEWS,
  awardsMinReviews,
  computeAwardsForYear,
  revokeAward,
  awardYears,
  awardCities,
  awardWinners,
  listingAwards,
  awardYearsForListings,
  hasAwardForYear,
  awardNotification,
  adminAwardYears,
  adminAwardsForYear,
  awardText,
  parseAwardYear,
} from "./awards";

afterEach(() => resetClock());

const YEAR = 2031;

async function adminViewer(tx: TestDb): Promise<Viewer> {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({
    id: userId, name: "Admin", email: `${userId}@example.test`, emailVerified: true,
  });
  await tx.insert(profiles).values({ userId, role: "admin" });
  return { role: "admin", userId };
}

/** A published, rated listing. The rating columns are set directly: this module reads them, it never writes them. */
function rated(tx: TestDb, ctx: ListingCtx, avg: string, count: number, patch: Record<string, unknown> = {}) {
  return makeListing(tx, ctx, { ratingAvg: avg, ratingCount: count, ...patch });
}

/** Three rated listings, one of which clearly wins. Returns the ids in insertion order. */
async function contest(tx: TestDb, ctx: ListingCtx): Promise<{ winner: string; others: string[] }> {
  const winner = await rated(tx, ctx, "4.9", 7, { name: "Clear Winner" });
  const b = await rated(tx, ctx, "4.2", 6, { name: "Runner Up" });
  const c = await rated(tx, ctx, "3.5", 9, { name: "Third" });
  return { winner, others: [b, c] };
}

describe("awardsMinReviews", () => {
  it("defaults to five and never accepts less than one", () => {
    expect(DEFAULT_AWARDS_MIN_REVIEWS).toBe(5);
    expect(awardsMinReviews({ minReviews: 8 })).toBe(8);
    expect(awardsMinReviews(undefined)).toBe(5);
    expect(awardsMinReviews({ minReviews: 0 })).toBe(1);
    expect(awardsMinReviews({ minReviews: Number.NaN })).toBe(5);
  });
});

describe("parseAwardYear", () => {
  it("accepts a plausible four-digit year and nothing else", () => {
    expect(parseAwardYear("2026")).toBe(2026);
    expect(parseAwardYear("02026")).toBeNull();
    expect(parseAwardYear("1999")).toBeNull();
    expect(parseAwardYear("2200")).toBeNull();
    expect(parseAwardYear("abcd")).toBeNull();
    expect(parseAwardYear("2026.5")).toBeNull();
  });
});

describe("computeAwardsForYear", () => {
  it("is admin-only", async () => {
    await withTestDb(async (tx) => {
      await expect(computeAwardsForYear(tx, PUBLIC_VIEWER, YEAR)).rejects.toThrow("FORBIDDEN");
    });
  });

  it("awards the highest-rated listing with enough reviews in a city × category with three rated listings", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { winner } = await contest(tx, ctx);

      const result = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      expect(result.year).toBe(YEAR);
      expect(result.created).toHaveLength(1);
      expect(result.created[0]!.listingId).toBe(winner);

      const rows = await tx.select().from(awards).where(eq(awards.year, YEAR));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        listingId: winner, cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, rank: 1,
      });
      expect(rows[0]!.publishedAt).not.toBeNull();
      expect(rows[0]!.methodologyVersion).not.toBeNull();
    });
  });

  it(`needs at least ${AWARDS_MIN_RATED_LISTINGS} rated published listings in the city × category`, async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await rated(tx, ctx, "4.9", 7);
      await rated(tx, ctx, "4.2", 6);
      // Rated but not published: does not count towards the three.
      await rated(tx, ctx, "4.0", 6, { status: "pending" });
      // Published but unrated: does not count either.
      await makeListing(tx, ctx);

      const result = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      expect(result.created).toEqual([]);
    });
  });

  it("skips a listing under the review threshold even when it has the best average", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await rated(tx, ctx, "5.0", 2, { name: "Two Reviews" });
      const winner = await rated(tx, ctx, "4.4", 5, { name: "Five Reviews" });
      await rated(tx, ctx, "4.0", 8);

      const result = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR, { minReviews: 5 });
      expect(result.created.map((c) => c.listingId)).toEqual([winner]);
    });
  });

  it("awards nothing when no listing in the contest clears the threshold", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await rated(tx, ctx, "5.0", 2);
      await rated(tx, ctx, "4.4", 3);
      await rated(tx, ctx, "4.0", 4);

      const result = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR, { minReviews: 5 });
      expect(result.created).toEqual([]);
    });
  });

  it("never awards an unpublished listing, whatever its rating", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await rated(tx, ctx, "5.0", 20, { status: "removed" });
      const winner = await rated(tx, ctx, "4.4", 5);
      await rated(tx, ctx, "4.0", 8);
      await rated(tx, ctx, "3.9", 8);

      const result = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR, { minReviews: 5 });
      expect(result.created.map((c) => c.listingId)).toEqual([winner]);
    });
  });

  it("breaks a tie on average by review count, then by the older listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      setClock(new Date("2030-03-01T00:00:00Z"));
      const older = await rated(tx, ctx, "4.8", 6, { createdAt: new Date("2029-01-01T00:00:00Z") });
      const newer = await rated(tx, ctx, "4.8", 6, { createdAt: new Date("2029-06-01T00:00:00Z") });
      const moreReviews = await rated(tx, ctx, "4.8", 9, { createdAt: new Date("2029-12-01T00:00:00Z") });

      const byCount = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR, { minReviews: 5 });
      expect(byCount.created.map((c) => c.listingId)).toEqual([moreReviews]);

      // Same contest without the count-breaker: the older of the two equals wins.
      await tx.delete(awards).where(eq(awards.year, YEAR));
      await tx.update(listings).set({ ratingCount: 6 }).where(eq(listings.id, moreReviews));
      await tx.update(listings).set({ createdAt: new Date("2030-01-01T00:00:00Z") }).where(eq(listings.id, moreReviews));
      const byAge = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR, { minReviews: 5 });
      expect(byAge.created.map((c) => c.listingId)).toEqual([older]);
      expect(byAge.created.map((c) => c.listingId)).not.toContain(newer);
    });
  });

  it("is idempotent: a second run for the same year creates nothing and keeps the first winner", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { winner } = await contest(tx, ctx);

      const first = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      expect(first.created).toHaveLength(1);

      // The standings change; the award for the year does not.
      const [runnerUp] = await tx.select({ id: listings.id }).from(listings).where(eq(listings.name, "Runner Up"));
      await tx.update(listings).set({ ratingAvg: "5.0", ratingCount: 30 }).where(eq(listings.id, runnerUp!.id));

      const second = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      expect(second.created).toEqual([]);
      expect(second.skipped).toBe(1);

      const rows = await tx.select().from(awards).where(eq(awards.year, YEAR));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.listingId).toBe(winner);
    });
  });

  it("does not re-award a slot whose award was revoked", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await contest(tx, ctx);
      const first = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      const admin = await adminViewer(tx);
      await revokeAward(tx, admin, first.created[0]!.awardId, { reason: "Reviews were bought", ip: "203.0.113.9" });

      const second = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      expect(second.created).toEqual([]);
      const rows = await tx.select().from(awards).where(eq(awards.year, YEAR));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revokedAt).not.toBeNull();
    });
  });

  it("awards each city × category independently and different years independently", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { winner: a } = await contest(tx, ctx);
      const otherCategory = await makeCategoryInCity(tx, ctx.verticalId, ctx.cityId, "Marquee Hire");
      const { winner: b } = await contest(tx, { ...ctx, primaryCategoryId: otherCategory });
      const otherCity = await makeCity(tx, "York", "North Yorkshire");
      const { winner: c } = await contest(tx, { ...ctx, cityId: otherCity });

      const result = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      expect(new Set(result.created.map((r) => r.listingId))).toEqual(new Set([a, b, c]));

      const nextYear = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR + 1);
      expect(nextYear.created).toHaveLength(3);
    });
  });

  it("queues one winner email per award, inside the same transaction, and writes an audit row with the admin's ip", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await contest(tx, ctx);
      const result = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR, { ip: "203.0.113.9" });

      const jobs = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_AWARD_WON));
      const mine = jobs.filter((j) => (j.payload as { awardId?: string }).awardId === result.created[0]!.awardId);
      expect(mine).toHaveLength(1);

      const audits = await tx.select().from(auditLog).where(eq(auditLog.action, "awards.computed"));
      const auditRow = audits.find((a) => (a.meta as { year: number }).year === YEAR);
      expect(auditRow).toBeDefined();
      expect(auditRow!.ip).toBe("203.0.113.9");
      expect(auditRow!.meta).toMatchObject({ created: 1, skipped: 0 });

      // The worker has no address: the row still lands, with a null ip.
      const later = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR + 1);
      expect(later.created).toHaveLength(1);
      const workerRow = (await tx.select().from(auditLog).where(eq(auditLog.action, "awards.computed")))
        .find((a) => (a.meta as { year: number }).year === YEAR + 1);
      expect(workerRow!.ip).toBeNull();
    });
  });
});

describe("revokeAward", () => {
  it("is admin-only", async () => {
    await withTestDb(async (tx) => {
      await expect(revokeAward(tx, PUBLIC_VIEWER, randomUUID(), { reason: "x", ip: null })).rejects.toThrow("FORBIDDEN");
      await expect(revokeAward(tx, { role: "owner", userId: "u_1" }, randomUUID(), { reason: "x", ip: null })).rejects.toThrow("FORBIDDEN");
    });
  });

  it("marks the row, records the reason and the admin's ip in the audit log, and hides it from every public read", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { winner } = await contest(tx, ctx);
      const { created } = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      const awardId = created[0]!.awardId;
      const admin = await adminViewer(tx);

      const result = await revokeAward(tx, admin, awardId, { reason: "Reviews were bought", ip: "203.0.113.9" });
      expect(result).toMatchObject({ outcome: "revoked", listingId: winner });

      const [row] = await tx.select().from(awards).where(eq(awards.id, awardId));
      expect(row!.revokedAt).not.toBeNull();
      expect(row!.revokeReason).toBe("Reviews were bought");

      const [audit] = await tx.select().from(auditLog).where(eq(auditLog.entityId, awardId));
      expect(audit).toMatchObject({ action: "award.revoked", entityType: "award", ip: "203.0.113.9" });
      expect(audit!.actorId).not.toBeNull();
      expect(audit!.meta).toMatchObject({ reason: "Reviews were bought", year: YEAR });

      expect(await listingAwards(tx, PUBLIC_VIEWER, winner)).toEqual([]);
      expect(await hasAwardForYear(tx, PUBLIC_VIEWER, winner, YEAR)).toBe(false);
      expect((await awardYears(tx, PUBLIC_VIEWER)).find((y) => y.year === YEAR)).toBeUndefined();
    });
  });

  it("reports an award that is already revoked or not there", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await contest(tx, ctx);
      const { created } = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      const admin = await adminViewer(tx);

      // No reason, no revoke — the reason is the record.
      await expect(revokeAward(tx, admin, created[0]!.awardId, { reason: "   ", ip: null })).rejects.toThrow(/reason/);
      await revokeAward(tx, admin, created[0]!.awardId, { reason: "once", ip: null });
      expect((await revokeAward(tx, admin, created[0]!.awardId, { reason: "twice", ip: null })).outcome).toBe("already-revoked");
      expect((await revokeAward(tx, admin, randomUUID(), { reason: "x", ip: null })).outcome).toBe("not-found");
      expect((await revokeAward(tx, admin, "not-a-uuid", { reason: "x", ip: null })).outcome).toBe("not-found");
    });
  });
});

describe("public reads", () => {
  it("lists years, cities and winners, published listings only, active awards only", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { winner } = await contest(tx, ctx);
      const otherCity = await makeCity(tx, "York", "North Yorkshire");
      const { winner: yorkWinner } = await contest(tx, { ...ctx, cityId: otherCity });
      await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);

      const years = await awardYears(tx, PUBLIC_VIEWER);
      const thisYear = years.find((y) => y.year === YEAR);
      expect(thisYear).toEqual({ year: YEAR, winners: 2, cities: 2 });

      const citiesOut = await awardCities(tx, PUBLIC_VIEWER, YEAR);
      const names = citiesOut.filter((c) => [ctx.cityId, otherCity].includes(c.cityId));
      expect(names.map((c) => c.winners)).toEqual([1, 1]);
      expect(names.map((c) => c.name).sort()).toEqual(["Leeds", "York"]);

      const leeds = names.find((c) => c.cityId === ctx.cityId)!;
      const page = await awardWinners(tx, PUBLIC_VIEWER, YEAR, leeds.slug);
      expect(page).not.toBeNull();
      expect(page!.city.name).toBe("Leeds");
      expect(page!.winners).toHaveLength(1);
      expect(page!.winners[0]!.listing).toMatchObject({ id: winner, name: "Clear Winner" });
      expect(page!.winners[0]!.listing.path).toBe(`/${leeds.slug}/${page!.winners[0]!.listing.slug}`);
      expect(page!.winners[0]!.category.name).toBe("Barn Venues");

      // The winner is taken down: it vanishes from every public read without a revoke.
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, yorkWinner));
      expect((await awardYears(tx, PUBLIC_VIEWER)).find((y) => y.year === YEAR)).toEqual({ year: YEAR, winners: 1, cities: 1 });
      const york = names.find((c) => c.cityId === otherCity)!;
      expect(await awardWinners(tx, PUBLIC_VIEWER, YEAR, york.slug)).toBeNull();
      expect(await listingAwards(tx, PUBLIC_VIEWER, yorkWinner)).toEqual([]);
    });
  });

  it("returns null for a year or a city with no winners", async () => {
    await withTestDb(async (tx) => {
      expect(await awardWinners(tx, PUBLIC_VIEWER, 2099, "nowhere")).toBeNull();
      expect(await awardCities(tx, PUBLIC_VIEWER, 2099)).toEqual([]);
    });
  });

  it("reads a listing's awards and the years for a set of listings", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { winner, others } = await contest(tx, ctx);
      await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR + 1);

      const mine = await listingAwards(tx, PUBLIC_VIEWER, winner);
      expect(mine.map((a) => a.year)).toEqual([YEAR + 1, YEAR]);
      expect(mine[0]).toMatchObject({ cityName: "Leeds", categoryName: "Barn Venues" });
      expect(mine[0]!.awardsPath).toMatch(new RegExp(`^/awards/${YEAR + 1}/`));

      expect(await hasAwardForYear(tx, PUBLIC_VIEWER, winner, YEAR)).toBe(true);
      expect(await hasAwardForYear(tx, PUBLIC_VIEWER, winner, YEAR + 5)).toBe(false);
      expect(await hasAwardForYear(tx, PUBLIC_VIEWER, "nope", YEAR)).toBe(false);

      const map = await awardYearsForListings(tx, PUBLIC_VIEWER, [winner, ...others]);
      expect(map.get(winner)).toEqual([YEAR + 1, YEAR]);
      expect(map.has(others[0]!)).toBe(false);
      expect((await awardYearsForListings(tx, PUBLIC_VIEWER, [])).size).toBe(0);
    });
  });

  it("phrases the award from the year, category and town", () => {
    const text = awardText({ year: 2031, categoryName: "Barn Venues", cityName: "Leeds" });
    expect(text).toContain("2031");
    expect(text).toContain("Barn Venues");
    expect(text).toContain("Leeds");
  });
});

describe("awardNotification", () => {
  it("is admin-only and prefers the owner's account address over the listing's", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const userId = `u_${randomUUID()}`;
      await tx.insert(user).values({ id: userId, name: "Owner", email: "owner@example.test", emailVerified: true });
      const [profile] = await tx.insert(profiles).values({ userId, role: "owner" }).returning({ id: profiles.id });
      await rated(tx, ctx, "4.9", 7, { name: "Owned", ownerId: profile!.id, email: "listing@example.test" });
      await rated(tx, ctx, "4.2", 6);
      await rated(tx, ctx, "3.5", 9);
      const { created } = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);

      await expect(awardNotification(tx, PUBLIC_VIEWER, created[0]!.awardId)).rejects.toThrow("FORBIDDEN");

      const data = await awardNotification(tx, ADMIN_VIEWER, created[0]!.awardId);
      expect(data).toMatchObject({
        year: YEAR, listingName: "Owned", cityName: "Leeds", categoryName: "Barn Venues",
        recipient: "owner@example.test",
      });
      expect(data!.listingPath).toMatch(/^\/[a-z0-9-]+\/owned$/);
      expect(data!.revoked).toBe(false);
    });
  });

  it("falls back to a CLAIMED listing's own address, and to nobody", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await rated(tx, ctx, "4.9", 7, { email: "listing@example.test", claimStatus: "claimed" });
      await rated(tx, ctx, "4.2", 6);
      await rated(tx, ctx, "3.5", 9);
      const { created } = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      const awardId = created[0]!.awardId;
      expect((await awardNotification(tx, ADMIN_VIEWER, awardId))!.recipient).toBe("listing@example.test");

      await tx.update(listings).set({ claimStatus: "verified" }).where(eq(listings.id, created[0]!.listingId));
      expect((await awardNotification(tx, ADMIN_VIEWER, awardId))!.recipient).toBe("listing@example.test");

      await tx.update(listings).set({ email: null }).where(eq(listings.id, created[0]!.listingId));
      expect((await awardNotification(tx, ADMIN_VIEWER, awardId))!.recipient).toBeNull();
      expect(await awardNotification(tx, ADMIN_VIEWER, randomUUID())).toBeNull();
    });
  });

  it("never writes to an UNCLAIMED listing's contact address — the enquiry rule", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await rated(tx, ctx, "4.9", 7, { email: "listing@example.test", claimStatus: "unclaimed" });
      await rated(tx, ctx, "4.2", 6);
      await rated(tx, ctx, "3.5", 9);
      const { created } = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      const data = await awardNotification(tx, ADMIN_VIEWER, created[0]!.awardId);
      expect(data!.recipient).toBeNull();
      // The award itself stands: the pill and the row do not depend on an address.
      expect(await listingAwards(tx, PUBLIC_VIEWER, created[0]!.listingId)).toHaveLength(1);
    });
  });
});

describe("admin reads", () => {
  it("lists every year including revoked rows, and every row for a year with its state", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await contest(tx, ctx);
      const admin = await adminViewer(tx);
      const { created } = await computeAwardsForYear(tx, ADMIN_VIEWER, YEAR);
      await revokeAward(tx, admin, created[0]!.awardId, { reason: "bought", ip: null });

      await expect(adminAwardYears(tx, PUBLIC_VIEWER)).rejects.toThrow("FORBIDDEN");
      const years = await adminAwardYears(tx, admin);
      expect(years.find((y) => y.year === YEAR)).toEqual({ year: YEAR, winners: 0, revoked: 1 });

      const rows = await adminAwardsForYear(tx, admin, YEAR);
      const mine = rows.filter((r) => r.awardId === created[0]!.awardId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        listingName: "Clear Winner", cityName: "Leeds", categoryName: "Barn Venues",
        revokeReason: "bought",
      });
      expect(mine[0]!.revokedAt).not.toBeNull();

      // Public reads still see nothing for the year.
      expect((await awardYears(tx, PUBLIC_VIEWER)).find((y) => y.year === YEAR)).toBeUndefined();
      await tx.delete(awards).where(inArray(awards.id, created.map((c) => c.awardId)));
    });
  });
});
