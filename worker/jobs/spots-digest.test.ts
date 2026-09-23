import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { jobQueue, profiles, subscriptions, unsubscribes, user } from "@/lib/db/schema";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { resetClock, setClock } from "@/lib/clock";
import { siteConfig } from "@/config/site.config";
import { formatMoney } from "@/lib/pricing";
import type { SendResult } from "@/lib/email/sender";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();
vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const { createPendingSubscription } = await import("@/lib/db/queries/billing");
const { citySpotKey, createFeaturedSubscription, ensureSpot, insertBid } = await import("@/lib/db/queries/spots");
const { rerankSpots } = await import("@/lib/spots/engine");
const { NOTIFY_SPOT_DIGEST } = await import("@/lib/email/notify");
const { processNotifications } = await import("./notify");
const { isFirstMonday, runSpotsDigest, SPOTS_DIGEST_CRON } = await import("./spots-digest");

/**
 * The monthly digest: the first Monday of the month, once, to every
 * verified listing on a paid plan with a free spot on one of its pages —
 * unless its owner's address has unsubscribed — and once to the admin with
 * the site-wide table.
 */

const ENV = { ...process.env };
beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ sent: true, id: "eml_1" });
  process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.co.uk";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "digest-secret";
});
afterEach(() => {
  resetClock();
  process.env = { ...ENV };
});

/** 5 October 2026 is the first Monday of that month. 09:00 in London is 08:00Z (BST). */
const FIRST_MONDAY = new Date("2026-10-05T08:00:00Z");

const money = (cents: number) => formatMoney(cents / 100, siteConfig.locale, siteConfig.currency);

async function verified(
  tx: TestDb,
  ctx: ListingCtx,
  name: string,
  patch: { claimStatus?: "verified" | "claimed"; sub?: boolean; email?: boolean } = {},
) {
  const userId = `u_${randomUUID()}`;
  const email = `${name.toLowerCase().replace(/\s+/g, "-")}@example.test`;
  await tx.insert(user).values({ id: userId, name, email: patch.email === false ? "" : email, emailVerified: true });
  const [profile] = await tx.insert(profiles).values({ userId, role: "owner" }).returning({ id: profiles.id });
  const viewer = { role: "user" as const, userId };
  const listingId = await makeListing(tx, ctx, {
    name, ownerId: profile!.id, claimStatus: patch.claimStatus ?? "verified", tier: "premium",
  });
  if (patch.sub !== false) {
    const id = await createPendingSubscription(tx, viewer, {
      listingId, profileId: profile!.id, tier: "premium", interval: "monthly", providerPlanId: "P-1", ip: null,
    });
    await tx.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.id, id));
  }
  return { listingId, viewer, profileId: profile!.id, email };
}

const digestJobs = (tx: TestDb) => tx.select({ payload: jobQueue.payload }).from(jobQueue).where(eq(jobQueue.kind, NOTIFY_SPOT_DIGEST));

describe("isFirstMonday", () => {
  it("is the first Monday in the site's own zone", () => {
    expect(SPOTS_DIGEST_CRON).toBe("0 9 * * 1");
    expect(isFirstMonday(FIRST_MONDAY, "Europe/London")).toBe(true);
    expect(isFirstMonday(new Date("2026-10-12T08:00:00Z"), "Europe/London")).toBe(false);
    expect(isFirstMonday(new Date("2026-10-06T08:00:00Z"), "Europe/London")).toBe(false);
    // 23:30Z on Sunday 1 Nov 2026 is already Monday 2 Nov in Sydney.
    expect(isFirstMonday(new Date("2026-11-01T23:30:00Z"), "Australia/Sydney")).toBe(true);
    expect(isFirstMonday(new Date("2026-11-01T23:30:00Z"), "Europe/London")).toBe(false);
  });
});

describe("runSpotsDigest", () => {
  it("does nothing on any other Monday", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-10-12T08:00:00Z"));
      const ctx = await makeScaffold(tx);
      await verified(tx, ctx, "Quiet Quay");
      expect(await runSpotsDigest(tx)).toEqual({ skipped: "not-first-monday", queued: 0, admin: false });
      expect(await digestJobs(tx)).toEqual([]);
    });
  });

  it("queues one job per verified paying listing with room near it, skips the ineligible and the unsubscribed, once a month", async () => {
    await withTestDb(async (tx) => {
      setClock(FIRST_MONDAY);
      const ctx = await makeScaffold(tx);
      const alpha = await verified(tx, ctx, "Alpha Abbey");
      await verified(tx, ctx, "Bravo Barn", { claimStatus: "claimed" });
      await verified(tx, ctx, "Charlie Chapel", { sub: false });
      const delta = await verified(tx, ctx, "Delta Dock");
      await tx.insert(unsubscribes).values({ addressNormalised: delta.email, reason: "test" });
      // Echo holds the city spot: its category and region spots still have room.
      const echo = await verified(tx, ctx, "Echo Hall");
      const spot = await ensureSpot(tx, echo.viewer, citySpotKey(ctx.cityId, null));
      const sub = await createFeaturedSubscription(tx, echo.viewer, { listingId: echo.listingId, profileId: echo.profileId, planId: "P-F", quantity: 1, ip: null });
      await insertBid(tx, echo.viewer, { spotId: spot.id, listingId: echo.listingId, subscriptionId: sub, amountCents: 6000, status: "active", ip: null });
      await rerankSpots(tx, [spot.id]);

      const result = await runSpotsDigest(tx);
      expect(result).toEqual({ queued: 2, admin: true });
      const payloads = (await digestJobs(tx)).map((j) => j.payload);
      expect(payloads).toEqual(expect.arrayContaining([{ listingId: alpha.listingId }, { listingId: echo.listingId }, { admin: true }]));
      expect(payloads).toHaveLength(3);

      // The same month again: nothing.
      setClock(new Date("2026-10-05T09:30:00Z"));
      expect(await runSpotsDigest(tx)).toEqual({ skipped: "already-sent", queued: 0, admin: false });
      expect(await digestJobs(tx)).toHaveLength(3);

      // The emails, as sent.
      expect(await processNotifications(tx)).toBe(3);
      const to = sendEmail.mock.calls.map((c) => String(c[0]!.to));
      expect(to.sort()).toEqual([alpha.email, "admin@example.co.uk", echo.email].sort());
      const alphaMail = sendEmail.mock.calls.find((c) => c[0]!.to === alpha.email)![0]!;
      // Alpha: town spot has 2 free, town × category, region, region × category — 4 spots with room.
      expect(String(alphaMail.subject)).toBe("4 spots near you are empty");
      expect(String(alphaMail.text)).toContain(`from ${money(siteConfig.featured.floors.city * 100)}/month`);
      expect(String(alphaMail.text)).toContain("/unsubscribe?t=");
      expect(String(alphaMail.text)).toContain(`/account/listings/${alpha.listingId}/featured`);
      const echoMail = sendEmail.mock.calls.find((c) => c[0]!.to === echo.email)![0]!;
      expect(String(echoMail.subject)).toBe("3 spots near you are empty");
      const adminMail = sendEmail.mock.calls.find((c) => c[0]!.to === "admin@example.co.uk")![0]!;
      expect(String(adminMail.text)).toContain("Leeds: 1 of 3 taken");
      expect(String(adminMail.text)).toContain("West Yorkshire: 0 of 3 taken");
      expect(String(adminMail.text)).toContain("/admin/spots/export");
    });
  });

  it("an owner job whose listing has since unsubscribed sends nothing and completes", async () => {
    await withTestDb(async (tx) => {
      setClock(FIRST_MONDAY);
      const ctx = await makeScaffold(tx);
      const alpha = await verified(tx, ctx, "Late Leaver");
      expect((await runSpotsDigest(tx)).queued).toBe(1);
      await tx.insert(unsubscribes).values({ addressNormalised: alpha.email, reason: "test" });
      expect(await processNotifications(tx)).toBe(2);
      expect(sendEmail.mock.calls.map((c) => c[0]!.to)).toEqual(["admin@example.co.uk"]);
    });
  });
});
