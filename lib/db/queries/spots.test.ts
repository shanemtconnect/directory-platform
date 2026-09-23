import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import { cities, listingCategories, listings, subscriptions, user } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeCategoryInCity, makeCity, makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { ensureProfile } from "@/lib/auth/profile";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { createPendingSubscription } from "@/lib/db/queries/billing";
import { slugify } from "@/lib/routing/slugify";
import {
  applyRanking,
  cancelListingBids,
  chargeableBidsForListing,
  citySpotKey,
  createFeaturedSubscription,
  currentFeaturedSubscription,
  ensureSpot,
  featuredForScope,
  findSpot,
  insertBid,
  listingForBidding,
  regionSpotKey,
  spotBids,
  spotPaths,
  spotsForKeys,
} from "./spots";

const ADMIN = { role: "admin" as const, userId: "worker" };

async function makeOwner(tx: TestDb) {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Owner", email: `${userId}@example.test` });
  const viewer = { role: "user" as const, userId };
  const { id: profileId } = await ensureProfile(tx, viewer);
  return { viewer, profileId };
}

/** A verified, published listing on an active paid plan: the one that may bid. */
async function makeBidder(
  tx: TestDb,
  ctx: ListingCtx,
  patch: Partial<typeof listings.$inferInsert> = {},
  sub: { tier: "essential" | "premium"; status: string } | null = { tier: "premium", status: "active" },
) {
  const owner = await makeOwner(tx);
  const listingId = await makeListing(tx, ctx, {
    ownerId: owner.profileId,
    claimStatus: "verified",
    tier: sub?.tier ?? "free",
    ...patch,
  });
  if (sub !== null) {
    const id = await createPendingSubscription(tx, owner.viewer, {
      listingId,
      profileId: owner.profileId,
      tier: sub.tier,
      interval: "monthly",
      providerPlanId: "P-1",
      ip: null,
    });
    await tx.update(subscriptions).set({ status: sub.status }).where(eq(subscriptions.id, id));
  }
  return { ...owner, listingId };
}

describe("ensureSpot / findSpot", () => {
  it("creates a city spot once, with the configured floor and positions", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const key = citySpotKey(ctx.cityId, null);
      expect(await findSpot(tx, PUBLIC_VIEWER, key)).toBeNull();

      const a = await ensureSpot(tx, owner.viewer, key);
      const b = await ensureSpot(tx, owner.viewer, key);
      expect(a.id).toBe(b.id);
      expect(a.floorCents).toBe(siteConfig.featured.floors.city * 100);
      expect(a.positions).toBe(siteConfig.featured.positions);
      expect(a.status).toBe("open");
      expect((await findSpot(tx, PUBLIC_VIEWER, key))?.id).toBe(a.id);
    });
  });

  it("keeps the city spot and the city x category spot apart", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const city = await ensureSpot(tx, owner.viewer, citySpotKey(ctx.cityId, null));
      const cat = await ensureSpot(tx, owner.viewer, citySpotKey(ctx.cityId, ctx.primaryCategoryId));
      expect(city.id).not.toBe(cat.id);
      const found = await spotsForKeys(tx, PUBLIC_VIEWER, [
        citySpotKey(ctx.cityId, null),
        citySpotKey(ctx.cityId, ctx.primaryCategoryId),
        citySpotKey(randomUUID(), null),
      ]);
      expect(found.size).toBe(2);
    });
  });

  it("prices a region spot from the region floor", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeOwner(tx);
      const spot = await ensureSpot(tx, owner.viewer, regionSpotKey("West Yorkshire", null));
      expect(spot.areaKind).toBe("region");
      expect(spot.areaId).toBe(slugify("West Yorkshire"));
      expect(spot.floorCents).toBe(siteConfig.featured.floors.region * 100);
    });
  });

  it("refuses to create a spot for an anonymous viewer", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await expect(ensureSpot(tx, PUBLIC_VIEWER, citySpotKey(ctx.cityId, null))).rejects.toThrow(
        "FORBIDDEN",
      );
    });
  });
});

describe("listingForBidding", () => {
  it("returns the listing, its region and every category to its owner", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const second = await makeCategoryInCity(tx, ctx.verticalId, ctx.cityId, "Hotel Venues");
      const b = await makeBidder(tx, ctx);
      await tx.insert(listingCategories).values({ listingId: b.listingId, categoryId: second });

      const got = await listingForBidding(tx, b.viewer, { listingId: b.listingId, profileId: b.profileId });
      expect(got?.eligible).toBe(true);
      expect(got?.region).toBe("West Yorkshire");
      expect([...(got?.categoryIds ?? [])].sort()).toEqual([ctx.primaryCategoryId, second].sort());
      expect(got?.cityPath).toMatch(/^\/[a-z0-9-]+$/);
    });
  });

  it("is null for somebody else's listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const b = await makeBidder(tx, ctx);
      const stranger = await makeOwner(tx);
      expect(
        await listingForBidding(tx, stranger.viewer, { listingId: b.listingId, profileId: stranger.profileId }),
      ).toBeNull();
    });
  });

  it.each([
    ["not verified", { claimStatus: "claimed" as const }, { tier: "premium" as const, status: "active" }, "not-verified"],
    ["not published", { status: "draft" as const }, { tier: "premium" as const, status: "active" }, "not-published"],
    ["no subscription at all", {}, null, "no-subscription"],
    ["a lapsed subscription", {}, { tier: "premium" as const, status: "cancelled" }, "no-subscription"],
  ])("is not eligible when %s", async (_label, patch, sub, reason) => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const b = await makeBidder(tx, ctx, patch, sub);
      const got = await listingForBidding(tx, b.viewer, { listingId: b.listingId, profileId: b.profileId });
      expect(got?.eligible).toBe(false);
      expect(got?.reason).toBe(reason);
    });
  });
});

describe("featuredForScope", () => {
  it("returns exactly the featured bids of the spot, in position order, published only", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx, { name: "Alpha" });
      const b = await makeBidder(tx, ctx, { name: "Bravo" });
      const c = await makeBidder(tx, ctx, { name: "Charlie", status: "archived" });
      const d = await makeBidder(tx, ctx, { name: "Delta" });
      const spot = await ensureSpot(tx, a.viewer, citySpotKey(ctx.cityId, null));
      for (const [who, amount] of [[a, 9000], [b, 8000], [c, 7000], [d, 6000]] as const) {
        const subId = await createFeaturedSubscription(tx, who.viewer, {
          listingId: who.listingId,
          profileId: who.profileId,
          planId: "P-F",
          quantity: amount / 100,
          ip: null,
        });
        await insertBid(tx, who.viewer, {
          spotId: spot.id,
          listingId: who.listingId,
          subscriptionId: subId,
          amountCents: amount,
          status: "active",
          ip: null,
        });
      }
      const bids = await spotBids(tx, PUBLIC_VIEWER, spot.id);
      await applyRanking(
        tx,
        ADMIN,
        spot.id,
        bids.map((bid, i) => ({ id: bid.id, listingId: bid.listingId, amountCents: bid.amountCents, position: i < 3 ? i + 1 : null })),
      );

      const rows = await featuredForScope(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId });
      // Charlie is archived, so the public row shows the two published ones
      // among the top three and never Delta, who is outbid.
      expect(rows.map((r) => r.name)).toEqual(["Alpha", "Bravo"]);
      expect(rows.map((r) => r.position)).toEqual([1, 2]);

      // The category page has its own spot, and nobody has bid on it.
      expect(
        await featuredForScope(tx, PUBLIC_VIEWER, {
          type: "city-category",
          cityId: ctx.cityId,
          categoryId: ctx.primaryCategoryId,
        }),
      ).toEqual([]);
    });
  });

  it("carries the listing's own city slug, so a cross-town bidder links home", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const otherCity = await makeCity(tx, "Bradford", "West Yorkshire");
      const a = await makeBidder(tx, { ...ctx, cityId: otherCity }, { name: "Away" });
      const spot = await ensureSpot(tx, a.viewer, citySpotKey(ctx.cityId, null));
      const subId = await createFeaturedSubscription(tx, a.viewer, {
        listingId: a.listingId, profileId: a.profileId, planId: "P-F", quantity: 60, ip: null,
      });
      const bidId = await insertBid(tx, a.viewer, {
        spotId: spot.id, listingId: a.listingId, subscriptionId: subId, amountCents: 6000, status: "active", ip: null,
      });
      await applyRanking(tx, ADMIN, spot.id, [{ id: bidId, listingId: a.listingId, amountCents: 6000, position: 1 }]);
      const [row] = await featuredForScope(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId });
      const [city] = await tx.select({ slug: cities.slug }).from(cities).where(eq(cities.id, otherCity));
      expect(row?.citySlug).toBe(city!.slug);
      expect(row?.citySlug).not.toBe(undefined);
    });
  });

  it("shows nothing from a closed spot", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx);
      const spot = await ensureSpot(tx, a.viewer, citySpotKey(ctx.cityId, null));
      const subId = await createFeaturedSubscription(tx, a.viewer, {
        listingId: a.listingId, profileId: a.profileId, planId: "P-F", quantity: 60, ip: null,
      });
      const bidId = await insertBid(tx, a.viewer, {
        spotId: spot.id, listingId: a.listingId, subscriptionId: subId, amountCents: 6000, status: "active", ip: null,
      });
      await applyRanking(tx, ADMIN, spot.id, [{ id: bidId, listingId: a.listingId, amountCents: 6000, position: 1 }]);
      expect(await featuredForScope(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId })).toHaveLength(1);
      await tx.execute(sql`update featured_spots set status = 'closed' where id = ${spot.id}`);
      expect(await featuredForScope(tx, PUBLIC_VIEWER, { type: "city", cityId: ctx.cityId })).toEqual([]);
    });
  });
});

describe("bids and subscriptions", () => {
  it("tracks the current subscription, the chargeable bids and cancels them together", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeBidder(tx, ctx);
      const spot = await ensureSpot(tx, a.viewer, citySpotKey(ctx.cityId, null));
      expect(await currentFeaturedSubscription(tx, ADMIN, a.listingId)).toBeNull();

      const subId = await createFeaturedSubscription(tx, a.viewer, {
        listingId: a.listingId, profileId: a.profileId, planId: "P-F", quantity: 60, ip: null,
      });
      const current = await currentFeaturedSubscription(tx, ADMIN, a.listingId);
      expect(current?.id).toBe(subId);
      expect(current?.status).toBe("approval_pending");
      expect(current?.requestedQuantity).toBe(60);
      expect(current?.quantity).toBe(0);

      const bidId = await insertBid(tx, a.viewer, {
        spotId: spot.id, listingId: a.listingId, subscriptionId: subId, amountCents: 6000, status: "pending", ip: null,
      });
      expect(await chargeableBidsForListing(tx, ADMIN, a.listingId)).toEqual([
        { amountCents: 6000, status: "pending", position: null },
      ]);

      // A second live bid on the same spot is refused by the database itself
      // (in a savepoint, so the outer transaction survives the refusal).
      await expect(
        tx.transaction((sp) =>
          insertBid(sp as unknown as TestDb, a.viewer, {
            spotId: spot.id, listingId: a.listingId, subscriptionId: subId, amountCents: 7000, status: "pending", ip: null,
          }),
        ),
      ).rejects.toThrow();

      const spots = await cancelListingBids(tx, ADMIN, a.listingId, { reason: "lapsed" });
      expect(spots).toEqual([spot.id]);
      const [row] = await spotBids(tx, PUBLIC_VIEWER, spot.id);
      expect(row).toBeUndefined();
      expect(await chargeableBidsForListing(tx, ADMIN, a.listingId)).toEqual([]);
      expect(bidId).toBeTruthy();
    });
  });
});

describe("spotPaths", () => {
  it("names the city page for a city spot and the category pillar for a city x category spot", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const [city] = await tx.select({ slug: cities.slug }).from(cities).where(eq(cities.id, ctx.cityId));
      const citySpot = await ensureSpot(tx, owner.viewer, citySpotKey(ctx.cityId, null));
      const catSpot = await ensureSpot(tx, owner.viewer, citySpotKey(ctx.cityId, ctx.primaryCategoryId));
      expect(await spotPaths(tx, PUBLIC_VIEWER, citySpot.id)).toEqual([`/${city!.slug}`]);
      expect(await spotPaths(tx, PUBLIC_VIEWER, catSpot.id)).toEqual([`/${city!.slug}/barn-venues`]);
    });
  });

  it("names the region page for a region spot, and nothing for an unknown spot", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeOwner(tx);
      await makeCity(tx, "Halifax", "West Yorkshire");
      const spot = await ensureSpot(tx, owner.viewer, regionSpotKey("West Yorkshire", null));
      expect(await spotPaths(tx, PUBLIC_VIEWER, spot.id)).toEqual(["/areas/west-yorkshire"]);
      expect(await spotPaths(tx, PUBLIC_VIEWER, randomUUID())).toEqual([]);
    });
  });
});
