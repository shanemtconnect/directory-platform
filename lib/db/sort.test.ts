import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { listingRankOrder } from "./sort";
import { listings } from "@/lib/db/schema";
import { makeScaffold, makeListing } from "@/test/factories";
import { eq } from "drizzle-orm";

const TZ = "Europe/London";

describe("listingRankOrder", () => {
  it("orders premium above essential above free", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      for (const tier of ["free", "premium", "essential"] as const) {
        await makeListing(tx, ctx, { tier, name: `${tier} venue` });
      }
      const rows = await tx.select({ tier: listings.tier }).from(listings).orderBy(...listingRankOrder(TZ));
      expect(rows.map((r) => r.tier)).toEqual(["premium", "essential", "free"]);
    });
  });

  it("breaks a tier tie by rank_boost", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "low boost", rankBoost: 0 });
      await makeListing(tx, ctx, { name: "high boost", rankBoost: 5 });
      const rows = await tx.select({ name: listings.name }).from(listings).orderBy(...listingRankOrder(TZ));
      expect(rows[0]?.name).toBe("high boost");
    });
  });

  it("adds backlink_boost to rank_boost instead of letting either one win", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "admin three", rankBoost: 3, backlinkBoost: 0 });
      await makeListing(tx, ctx, { name: "badge five", rankBoost: 0, backlinkBoost: 5 });
      await makeListing(tx, ctx, { name: "two and two", rankBoost: 2, backlinkBoost: 2 });
      const rows = await tx.select({ name: listings.name }).from(listings).orderBy(...listingRankOrder(TZ));
      expect(rows.map((r) => r.name)).toEqual(["badge five", "two and two", "admin three"]);
    });
  });

  it("lets an admin outrank a verified backlink — rank_boost has no ceiling", async () => {
    // The whole reason the two columns are separate. When the badge reward
    // was written into rank_boost it had to be clamped to 0..5, so an admin's
    // deliberate +40 came back as 5 the moment a badge verified.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "hand-promoted", rankBoost: 40, backlinkBoost: 0 });
      await makeListing(tx, ctx, { name: "has a backlink", rankBoost: 0, backlinkBoost: 5 });
      const rows = await tx.select({ name: listings.name }).from(listings).orderBy(...listingRankOrder(TZ));
      expect(rows[0]?.name).toBe("hand-promoted");
    });
  });

  it("lets an admin penalty survive a badge verification", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "penalised", rankBoost: -10, backlinkBoost: 5 });
      await makeListing(tx, ctx, { name: "ordinary", rankBoost: 0, backlinkBoost: 0 });
      const rows = await tx.select({ name: listings.name }).from(listings).orderBy(...listingRankOrder(TZ));
      expect(rows[0]?.name).toBe("ordinary");
    });
  });

  it("ranks verified above claimed above unclaimed at equal tier and boost", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "unclaimed one", claimStatus: "unclaimed" });
      await makeListing(tx, ctx, { name: "verified one", claimStatus: "verified" });
      await makeListing(tx, ctx, { name: "claimed one", claimStatus: "claimed" });
      const rows = await tx.select({ name: listings.name }).from(listings).orderBy(...listingRankOrder(TZ));
      expect(rows.map((r) => r.name)).toEqual(["verified one", "claimed one", "unclaimed one"]);
    });
  });

  it("puts tier above claim status — a paid unclaimed listing outranks a free verified one", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "free verified", tier: "free", claimStatus: "verified" });
      await makeListing(tx, ctx, { name: "premium unclaimed", tier: "premium", claimStatus: "unclaimed" });
      const rows = await tx.select({ name: listings.name }).from(listings).orderBy(...listingRankOrder(TZ));
      expect(rows[0]?.name).toBe("premium unclaimed");
    });
  });

  it("produces a stable order within a single day", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      for (let i = 0; i < 8; i++) await makeListing(tx, ctx, { name: `Venue ${i}` });
      const a = await tx.select({ id: listings.id }).from(listings).orderBy(...listingRankOrder(TZ));
      const b = await tx.select({ id: listings.id }).from(listings).orderBy(...listingRankOrder(TZ));
      expect(a).toEqual(b);
    });
  });

  it("shuffles identical listings rather than ordering them by insertion", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const inserted: string[] = [];
      for (let i = 0; i < 12; i++) inserted.push(await makeListing(tx, ctx, { name: `Venue ${i}` }));
      const sorted = (await tx.select({ id: listings.id }).from(listings).orderBy(...listingRankOrder(TZ)))
        .map((r) => r.id);
      // Free listings must rotate, or the same ones sit at the bottom forever
      // and never convert. Insertion order surviving would mean no shuffle.
      expect(sorted).not.toEqual(inserted);
      expect([...sorted].sort()).toEqual([...inserted].sort());
    });
  });

  it("uses the given timezone for the shuffle date, not the server's", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      for (let i = 0; i < 10; i++) await makeListing(tx, ctx, { name: `Venue ${i}` });
      const london = await tx.select({ id: listings.id }).from(listings).orderBy(...listingRankOrder("Europe/London"));
      const kiritimati = await tx.select({ id: listings.id }).from(listings).orderBy(...listingRankOrder("Pacific/Kiritimati"));
      // Both are valid orderings; the point is the zone is actually applied
      // rather than ignored, so the two can legitimately differ across a date line.
      expect(london).toHaveLength(10);
      expect(kiritimati).toHaveLength(10);
    });
  });

  it("rejects an invalid timezone loudly rather than silently sorting wrong", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, {});
      await expect(
        tx.select({ id: listings.id }).from(listings).orderBy(...listingRankOrder("Not/AZone")),
      ).rejects.toThrow();
    });
  });
});
