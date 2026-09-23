import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { listings, subscriptions, unsubscribes, user } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { ensureProfile } from "@/lib/auth/profile";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { createPendingSubscription } from "@/lib/db/queries/billing";
import { rerankSpots } from "@/lib/spots/engine";
import { availabilityForListing, emptySpotsReport } from "@/lib/spots/availability";
import {
  citySpotKey,
  createFeaturedSubscription,
  eligibleListingIds,
  ensureSpot,
  featuredForSpotKey,
  insertBid,
  listingForSystem,
  regionSpotKey,
  spotLeaderboard,
} from "./spots";

const ADMIN = { role: "admin" as const, userId: "worker" };

async function bidder(tx: TestDb, ctx: ListingCtx, name: string, opts: { sub?: boolean; claim?: "verified" | "claimed" } = {}) {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name, email: `${userId}@example.test` });
  const viewer = { role: "user" as const, userId };
  const { id: profileId } = await ensureProfile(tx, viewer);
  const listingId = await makeListing(tx, ctx, { name, ownerId: profileId, claimStatus: opts.claim ?? "verified", tier: "premium" });
  if (opts.sub !== false) {
    const id = await createPendingSubscription(tx, viewer, { listingId, profileId, tier: "premium", interval: "monthly", providerPlanId: "P-1", ip: null });
    await tx.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.id, id));
  }
  return { viewer, profileId, listingId, email: `${userId}@example.test` };
}

async function activeBid(tx: TestDb, b: Awaited<ReturnType<typeof bidder>>, spotId: string, amountCents: number) {
  const sub = await createFeaturedSubscription(tx, b.viewer, { listingId: b.listingId, profileId: b.profileId, planId: "P-F", quantity: 1, ip: null });
  return insertBid(tx, b.viewer, { spotId, listingId: b.listingId, subscriptionId: sub, amountCents, status: "active", ip: null });
}

describe("featuredForSpotKey / spotLeaderboard", () => {
  it("answers the region spot in position order with the spot id, and the leaderboard carries names but no amounts", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await bidder(tx, ctx, "Alpha");
      const b = await bidder(tx, ctx, "Bravo");
      const spot = await ensureSpot(tx, a.viewer, regionSpotKey("West Yorkshire", null));
      await activeBid(tx, a, spot.id, 12000);
      await activeBid(tx, b, spot.id, 15000);
      await rerankSpots(tx, [spot.id]);

      const row = await featuredForSpotKey(tx, PUBLIC_VIEWER, { areaKind: "region", areaId: "west-yorkshire", categoryId: null });
      expect(row.map((r) => [r.name, r.position, r.spotId])).toEqual([["Bravo", 1, spot.id], ["Alpha", 2, spot.id]]);

      const board = (await spotLeaderboard(tx, PUBLIC_VIEWER, spot.id))!;
      expect(board.areaName).toBe("West Yorkshire");
      expect(board.path).toBe("/areas/west-yorkshire");
      expect(board.featured.map((f) => f.name)).toEqual(["Bravo", "Alpha"]);
      expect(JSON.stringify(board)).not.toContain("15000");
      expect(JSON.stringify(board)).not.toContain("12000");

      // An unpublished holder is not shown.
      await tx.update(listings).set({ status: "draft" }).where(eq(listings.id, b.listingId));
      expect((await spotLeaderboard(tx, PUBLIC_VIEWER, spot.id))!.featured.map((f) => f.name)).toEqual(["Alpha"]);
      expect(await spotLeaderboard(tx, PUBLIC_VIEWER, randomUUID())).toBeNull();
    });
  });
});

describe("availability", () => {
  it("counts the spots on a listing's pages with room it does not hold, priced at the cheapest entry", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await bidder(tx, ctx, "Alpha");
      const b = await bidder(tx, ctx, "Bravo");
      const c = await bidder(tx, ctx, "Charlie");
      const d = await bidder(tx, ctx, "Delta");
      // Town spot full at 60/70/80 without Alpha: the only way in is 61.
      const town = await ensureSpot(tx, a.viewer, citySpotKey(ctx.cityId, null));
      await activeBid(tx, b, town.id, 6000);
      await activeBid(tx, c, town.id, 7000);
      await activeBid(tx, d, town.id, 8000);
      // Alpha holds the category spot.
      const cat = await ensureSpot(tx, a.viewer, citySpotKey(ctx.cityId, ctx.primaryCategoryId));
      await activeBid(tx, a, cat.id, 5000);
      await rerankSpots(tx, [town.id, cat.id]);

      const alpha = (await availabilityForListing(tx, ADMIN, a.listingId))!;
      // Region and region × category (no rows yet) at the region floor; the town is full.
      expect(alpha.emptyCount).toBe(2);
      expect(alpha.fromCents).toBe(10000);
      expect(alpha.ownerEmail).toBe(a.email);
      expect(alpha.unsubscribed).toBe(false);

      const bravo = (await availabilityForListing(tx, ADMIN, b.listingId))!;
      // Bravo holds the town spot; category (Alpha alone, 2 free at the floor), region, region × category.
      expect(bravo.emptyCount).toBe(3);
      expect(bravo.fromCents).toBe(5000);

      await tx.insert(unsubscribes).values({ addressNormalised: b.email, reason: "t" });
      expect((await availabilityForListing(tx, ADMIN, b.listingId))!.unsubscribed).toBe(true);

      const ineligible = await bidder(tx, ctx, "Echo", { sub: false });
      expect(await availabilityForListing(tx, ADMIN, ineligible.listingId)).toBeNull();
      const claimed = await bidder(tx, ctx, "Foxtrot", { claim: "claimed" });
      expect(await listingForSystem(tx, ADMIN, claimed.listingId)).toMatchObject({ eligible: false, reason: "not-verified" });

      const ids = await eligibleListingIds(tx, ADMIN);
      for (const id of [a.listingId, b.listingId, c.listingId, d.listingId]) expect(ids).toContain(id);
      expect(ids).not.toContain(ineligible.listingId);
      expect(ids).not.toContain(claimed.listingId);
    });
  });

  it("the site-wide report lists every spot row and a virtual row per published city and region", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await bidder(tx, ctx, "Alpha");
      const cat = await ensureSpot(tx, a.viewer, citySpotKey(ctx.cityId, ctx.primaryCategoryId));
      await activeBid(tx, a, cat.id, 5000);
      await rerankSpots(tx, [cat.id]);

      const report = await emptySpotsReport(tx, ADMIN);
      const leeds = report.filter((r) => r.areaName === "Leeds");
      expect(leeds.map((r) => [r.categoryName, r.spotId === null, r.filled, r.topCents])).toEqual(
        expect.arrayContaining([
          [null, true, 0, null],
          [expect.any(String), false, 1, 5000],
        ]),
      );
      const region = report.find((r) => r.key.areaKind === "region" && r.areaName === "West Yorkshire")!;
      expect(region).toMatchObject({ spotId: null, filled: 0, floorCents: 10000, path: "/areas/west-yorkshire" });
      expect(leeds.find((r) => r.categoryName === null)?.path).toMatch(/^\/leeds/);
    });
  });
});
