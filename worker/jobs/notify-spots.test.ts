import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { featuredBids, jobQueue, profiles, user } from "@/lib/db/schema";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import type { SendResult } from "@/lib/email/sender";
import { siteConfig } from "@/config/site.config";
import { formatMoney } from "@/lib/pricing";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();
vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { citySpotKey, createFeaturedSubscription, ensureSpot, insertBid } = await import("@/lib/db/queries/spots");
const { rerankSpots } = await import("@/lib/spots/engine");
const { NOTIFY_SPOT_OUTBID, notifySpotOutbid } = await import("@/lib/email/notify");
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

const sentTo = () => sendEmail.mock.calls.map((c) => String(c[0]!.to));
const bodies = () => sendEmail.mock.calls.map((c) => String(c[0]!.text)).join("\n");
const bodyTo = (to: string) => sendEmail.mock.calls.filter((c) => c[0]!.to === to).map((c) => String(c[0]!.text)).join("\n");
const money = (cents: number) => formatMoney(cents / 100, siteConfig.locale, siteConfig.currency);

async function bidder(tx: TestDb, ctx: ListingCtx, spotId: string, amountCents: number, name: string) {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name, email: `${name.toLowerCase().replace(/\s+/g, "-")}@example.test`, emailVerified: true });
  const [profile] = await tx.insert(profiles).values({ userId, role: "owner" }).returning({ id: profiles.id });
  const viewer = { role: "user" as const, userId };
  const listingId = await makeListing(tx, ctx, { name, ownerId: profile!.id, claimStatus: "verified", tier: "premium" });
  const subscriptionId = await createFeaturedSubscription(tx, viewer, { listingId, profileId: profile!.id, planId: "P-F", quantity: 1, ip: null });
  const bidId = await insertBid(tx, viewer, { spotId, listingId, subscriptionId, amountCents, status: "active", ip: null });
  return { listingId, bidId, email: `${name.toLowerCase().replace(/\s+/g, "-")}@example.test` };
}

describe("notify.spot.outbid", () => {
  it("tells the owner who lost first what it takes to retake it, with the amount prefilled in the link", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const spot = await ensureSpot(tx, { role: "admin", userId: "w" }, citySpotKey(ctx.cityId, null));
      const alpha = await bidder(tx, ctx, spot.id, 6000, "Alpha Hall");
      await bidder(tx, ctx, spot.id, 5000, "Bravo Barn");
      await rerankSpots(tx, [spot.id]);
      // Charlie takes first with 80: Alpha needs max(80+10%, 80+5) = 88 to retake it.
      await bidder(tx, ctx, spot.id, 8000, "Charlie Court");
      await rerankSpots(tx, [spot.id]);

      const queued = await tx.select().from(jobQueue).where(eq(jobQueue.kind, NOTIFY_SPOT_OUTBID));
      expect(queued.map((j) => j.payload)).toEqual([{ bidId: alpha.bidId, kind: "lost-first" }]);

      expect(await processNotifications(tx)).toBe(1);
      expect(sentTo()).toEqual([alpha.email]);
      const text = bodies();
      expect(text).toContain("Alpha Hall");
      expect(text).toContain("#2");
      expect(text).toContain(money(8800));
      expect(text).toContain(`https://example.co.uk/account/listings/${alpha.listingId}/featured?bid=city%3A${ctx.cityId}%3A-&amount=88`);
      expect(text).toContain(`https://example.co.uk/spots/${spot.id}`);
      // Nobody else's amount is in it.
      expect(text).not.toContain(money(8000));
      expect(text).not.toContain(money(5000));
    });
  });

  it("dropped out: the amount is the lowest featured bid plus one; a bid that is back in sends nothing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const spot = await ensureSpot(tx, { role: "admin", userId: "w" }, citySpotKey(ctx.cityId, null));
      const delta = await bidder(tx, ctx, spot.id, 5000, "Delta Den");
      await bidder(tx, ctx, spot.id, 6000, "Echo Estate");
      const foxtrot = await bidder(tx, ctx, spot.id, 7000, "Foxtrot Farm");
      await rerankSpots(tx, [spot.id]);
      const golf = await bidder(tx, ctx, spot.id, 9000, "Golf Grange");
      await rerankSpots(tx, [spot.id]);

      // Two emails: Delta dropped out, Foxtrot lost first to Golf.
      expect(await processNotifications(tx)).toBe(2);
      expect(sentTo().sort()).toEqual([delta.email, foxtrot.email].sort());
      const text = bodyTo(delta.email);
      expect(text.toLowerCase()).toContain("no longer featured");
      // Featured now: 90, 70, 60 → lowest + 1 = 61.
      expect(text).toContain(money(6100));
      expect(text).toContain("amount=61");
      expect(bodyTo(foxtrot.email)).toContain("amount=99");

      // A job for Delta that is already stale when it runs — Delta is back
      // at #1 by then — sends nothing; Golf, who lost first to it, is told.
      sendEmail.mockClear();
      await notifySpotOutbid(tx, { role: "admin", userId: "w" }, { bidId: delta.bidId, kind: "dropped-out" });
      await tx.update(featuredBids).set({ amountCents: 10000 }).where(eq(featuredBids.id, delta.bidId));
      await rerankSpots(tx, [spot.id]);
      expect(await processNotifications(tx)).toBe(2);
      expect(sentTo()).toEqual([golf.email]);
    });
  });
});
