import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { withTestDb, type TestDb } from "@/test/db";
import { auditLog, badges, listings, profiles, user } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { makeListing, makeScaffold } from "@/test/factories";
import {
  badgeListing,
  registerBacklink,
  badgesDueForCheck,
  recordBacklinkCheck,
  applyBadgeCounters,
  BACKLINK_RANK_BOOST,
} from "./badges";

const ADMIN: Viewer = { role: "admin", userId: "00000000-0000-4000-8000-00000000adm1" };

describe("badgeListing", () => {
  it("returns the listing a public badge needs, with its canonical path parts", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, {
        name: "The Old Mill",
        claimStatus: "verified",
        ratingAvg: "4.8",
        ratingCount: 27,
      });

      const row = await badgeListing(tx, PUBLIC_VIEWER, id);
      expect(row).toMatchObject({
        id,
        name: "The Old Mill",
        slug: "the-old-mill",
        claimStatus: "verified",
        ratingAvg: "4.8",
        ratingCount: 27,
        citySlug: "leeds",
        cityName: "Leeds",
        categoryName: "Barn Venues",
      });
    });
  });

  it("hides a listing that is not published — a badge is a public claim", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, { name: "Pending Place" });
      await tx.update(listings).set({ status: "pending" }).where(eq(listings.id, id));

      expect(await badgeListing(tx, PUBLIC_VIEWER, id)).toBeNull();
    });
  });

  it("hides a removed listing too", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, { name: "Gone Away" });
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, id));

      expect(await badgeListing(tx, PUBLIC_VIEWER, id)).toBeNull();
    });
  });

  it("lets an admin see an unpublished listing, as everywhere else", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, { name: "Pending Place" });
      await tx.update(listings).set({ status: "pending" }).where(eq(listings.id, id));

      expect((await badgeListing(tx, ADMIN, id))?.name).toBe("Pending Place");
    });
  });

  it("returns null for an id that is not a uuid, rather than throwing", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      // Postgres answers a malformed uuid with an exception, which would leave
      // the badge route as a 500 on any hotlinked rubbish.
      expect(await badgeListing(tx, PUBLIC_VIEWER, "not-a-uuid")).toBeNull();
      expect(await badgeListing(tx, PUBLIC_VIEWER, "")).toBeNull();
    });
  });

  it("returns null for a uuid nothing matches", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      expect(
        await badgeListing(tx, PUBLIC_VIEWER, "00000000-0000-4000-8000-000000000000"),
      ).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Backlink registration, the check schedule and the counter flush.
// ---------------------------------------------------------------------------

const OWNER: Viewer = { role: "owner", userId: "auth-user-owner" };
const STRANGER: Viewer = { role: "owner", userId: "auth-user-stranger" };

/** A profiles row without dragging Better Auth's `user` table into a unit test. */
async function makeProfile(tx: TestDb): Promise<string> {
  const userId = `u-${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
  const [row] = await tx.insert(profiles).values({ userId }).returning({ id: profiles.id });
  return row!.id;
}

describe("registerBacklink", () => {
  it("creates the badge row and records the URL", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const profileId = await makeProfile(tx);
      const listingId = await makeListing(tx, ctx, { name: "Linked Place", ownerId: profileId });

      const badgeId = await registerBacklink(tx, OWNER, {
        listingId,
        url: "https://client.example/about",
        actorProfileId: profileId,
      });

      const [row] = await tx.select().from(badges).where(eq(badges.id, badgeId));
      expect(row).toMatchObject({
        listingId,
        backlinkUrl: "https://client.example/about",
        backlinkVerified: false,
        lastCheckedAt: null,
      });
    });
  });

  it("writes an audit_log row in the same transaction", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const profileId = await makeProfile(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: profileId });

      await registerBacklink(tx, OWNER, {
        listingId,
        url: "https://client.example/",
        actorProfileId: profileId,
        ip: "203.0.113.9",
      });

      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, listingId));
      expect(entry).toMatchObject({ action: "badge.backlink.register", actorId: profileId, ip: "203.0.113.9" });
    });
  });

  it("updates the existing badge row rather than making a second one", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const profileId = await makeProfile(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: profileId });

      const first = await registerBacklink(tx, OWNER, {
        listingId, url: "https://client.example/a", actorProfileId: profileId,
      });
      const second = await registerBacklink(tx, OWNER, {
        listingId, url: "https://client.example/b", actorProfileId: profileId,
      });

      expect(second).toBe(first);
      const rows = await tx.select().from(badges).where(eq(badges.listingId, listingId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.backlinkUrl).toBe("https://client.example/b");
    });
  });

  it("un-verifies and drops the boost when the URL changes", async () => {
    // The old page was checked; the new one has not been. Carrying the verified
    // flag across would hand out a permanent +5 for a link that moved to a page
    // nobody has looked at.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const profileId = await makeProfile(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: profileId });
      const badgeId = await registerBacklink(tx, OWNER, {
        listingId, url: "https://client.example/a", actorProfileId: profileId,
      });
      await recordBacklinkCheck(tx, ADMIN, { badgeId, verified: true });

      await registerBacklink(tx, OWNER, {
        listingId, url: "https://client.example/b", actorProfileId: profileId,
      });

      const [row] = await tx.select().from(badges).where(eq(badges.id, badgeId));
      expect(row).toMatchObject({ backlinkVerified: false, lastCheckedAt: null });
      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.rankBoost).toBe(0);
    });
  });

  it("keeps the verified flag when the same URL is re-registered", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const profileId = await makeProfile(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: profileId });
      const badgeId = await registerBacklink(tx, OWNER, {
        listingId, url: "https://client.example/a", actorProfileId: profileId,
      });
      await recordBacklinkCheck(tx, ADMIN, { badgeId, verified: true });

      await registerBacklink(tx, OWNER, {
        listingId, url: "https://client.example/a", actorProfileId: profileId,
      });

      const [row] = await tx.select().from(badges).where(eq(badges.id, badgeId));
      expect(row?.backlinkVerified).toBe(true);
    });
  });

  it("refuses a listing the viewer does not own", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const ownerProfile = await makeProfile(tx);
      const otherProfile = await makeProfile(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: ownerProfile });

      await expect(
        registerBacklink(tx, STRANGER, {
          listingId, url: "https://evil.example/", actorProfileId: otherProfile,
        }),
      ).rejects.toThrow(/FORBIDDEN/);
      expect(await tx.select().from(badges)).toHaveLength(0);
    });
  });

  it("refuses the public viewer outright", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      await expect(
        registerBacklink(tx, PUBLIC_VIEWER, {
          listingId, url: "https://client.example/", actorProfileId: null,
        }),
      ).rejects.toThrow(/FORBIDDEN/);
    });
  });

  it("refuses a URL that is not http(s)", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const profileId = await makeProfile(tx);
      const listingId = await makeListing(tx, ctx, { ownerId: profileId });
      for (const url of ["javascript:alert(1)", "file:///etc/passwd", "not a url", ""]) {
        await expect(
          registerBacklink(tx, OWNER, { listingId, url, actorProfileId: profileId }),
        ).rejects.toThrow(/URL/i);
      }
    });
  });
});

describe("badgesDueForCheck", () => {
  const AT = new Date("2026-09-12T12:00:00Z");
  const daysAgo = (n: number): Date => new Date(AT.getTime() - n * 86_400_000);

  it("returns a badge that has never been checked, with its canonical path parts", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });
      await tx.insert(badges).values({ listingId, backlinkUrl: "https://client.example/" });

      const due = await badgesDueForCheck(tx, ADMIN, { at: AT });
      expect(due).toHaveLength(1);
      expect(due[0]).toMatchObject({
        listingId,
        backlinkUrl: "https://client.example/",
        citySlug: "leeds",
        listingSlug: "the-old-mill",
      });
    });
  });

  it("skips a badge with no backlink URL — there is nothing to check", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      await tx.insert(badges).values({ listingId });
      await tx.insert(badges).values({ listingId, backlinkUrl: "   " });

      expect(await badgesDueForCheck(tx, ADMIN, { at: AT })).toHaveLength(0);
    });
  });

  it("re-checks an unverified badge daily and a verified one weekly", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeListing(tx, ctx, { name: "Unverified Two Days" });
      const b = await makeListing(tx, ctx, { name: "Verified Two Days" });
      const c = await makeListing(tx, ctx, { name: "Verified Eight Days" });
      await tx.insert(badges).values([
        { listingId: a, backlinkUrl: "https://a.example/", backlinkVerified: false, lastCheckedAt: daysAgo(2) },
        { listingId: b, backlinkUrl: "https://b.example/", backlinkVerified: true, lastCheckedAt: daysAgo(2) },
        { listingId: c, backlinkUrl: "https://c.example/", backlinkVerified: true, lastCheckedAt: daysAgo(8) },
      ]);

      const due = await badgesDueForCheck(tx, ADMIN, { at: AT });
      expect(due.map((d) => d.listingId).sort()).toEqual([a, c].sort());
    });
  });

  it("leaves an unverified badge checked an hour ago alone", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      await tx.insert(badges).values({
        listingId, backlinkUrl: "https://a.example/", lastCheckedAt: new Date(AT.getTime() - 3_600_000),
      });
      expect(await badgesDueForCheck(tx, ADMIN, { at: AT })).toHaveLength(0);
    });
  });

  it("skips badges on listings that are not published", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, listingId));
      await tx.insert(badges).values({ listingId, backlinkUrl: "https://a.example/" });

      expect(await badgesDueForCheck(tx, ADMIN, { at: AT })).toHaveLength(0);
    });
  });

  it("honours the limit and takes the stalest first", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const older = await makeListing(tx, ctx, { name: "Older" });
      const newer = await makeListing(tx, ctx, { name: "Newer" });
      await tx.insert(badges).values([
        { listingId: newer, backlinkUrl: "https://n.example/", lastCheckedAt: daysAgo(2) },
        { listingId: older, backlinkUrl: "https://o.example/", lastCheckedAt: daysAgo(30) },
      ]);

      const due = await badgesDueForCheck(tx, ADMIN, { at: AT, limit: 1 });
      expect(due.map((d) => d.listingId)).toEqual([older]);
    });
  });

  it("is admin-only — the schedule is not public information", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      await expect(badgesDueForCheck(tx, PUBLIC_VIEWER, { at: AT })).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("recordBacklinkCheck", () => {
  it("marks the badge verified and adds the rank boost once", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const [badge] = await tx
        .insert(badges)
        .values({ listingId, backlinkUrl: "https://a.example/" })
        .returning({ id: badges.id });

      const at = new Date("2026-09-12T12:00:00Z");
      await recordBacklinkCheck(tx, ADMIN, { badgeId: badge!.id, verified: true, at });
      await recordBacklinkCheck(tx, ADMIN, { badgeId: badge!.id, verified: true, at });

      const [row] = await tx.select().from(badges).where(eq(badges.id, badge!.id));
      expect(row?.backlinkVerified).toBe(true);
      expect(row?.lastCheckedAt?.toISOString()).toBe(at.toISOString());
      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      // Idempotent: two passes do not stack to +10, and the cap is 5.
      expect(listing?.rankBoost).toBe(BACKLINK_RANK_BOOST);
    });
  });

  it("takes the boost back when the link disappears", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const [badge] = await tx
        .insert(badges)
        .values({ listingId, backlinkUrl: "https://a.example/" })
        .returning({ id: badges.id });

      await recordBacklinkCheck(tx, ADMIN, { badgeId: badge!.id, verified: true });
      await recordBacklinkCheck(tx, ADMIN, { badgeId: badge!.id, verified: false });
      await recordBacklinkCheck(tx, ADMIN, { badgeId: badge!.id, verified: false });

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.rankBoost).toBe(0);
      const [row] = await tx.select().from(badges).where(eq(badges.id, badge!.id));
      expect(row?.backlinkVerified).toBe(false);
      // Still stamped: a failed check is a check, or the job retries for ever.
      expect(row?.lastCheckedAt).not.toBeNull();
    });
  });

  it("never pushes rank_boost past the cap or below zero", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { rankBoost: 4 });
      const [badge] = await tx
        .insert(badges)
        .values({ listingId, backlinkUrl: "https://a.example/" })
        .returning({ id: badges.id });

      await recordBacklinkCheck(tx, ADMIN, { badgeId: badge!.id, verified: true });
      let [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.rankBoost).toBe(BACKLINK_RANK_BOOST);

      await recordBacklinkCheck(tx, ADMIN, { badgeId: badge!.id, verified: false });
      [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.rankBoost).toBe(0);
    });
  });

  it("is admin-only", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const [badge] = await tx
        .insert(badges)
        .values({ listingId })
        .returning({ id: badges.id });
      await expect(
        recordBacklinkCheck(tx, OWNER, { badgeId: badge!.id, verified: true }),
      ).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("applyBadgeCounters", () => {
  it("adds impressions and clicks to the badge row", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      await tx.insert(badges).values({ listingId, impressionCount: 3, clickCount: 1 });

      const applied = await applyBadgeCounters(tx, ADMIN, [
        { listingId, impressions: 10, clicks: 2 },
      ]);

      expect(applied).toBe(1);
      const [row] = await tx.select().from(badges).where(eq(badges.listingId, listingId));
      expect(row).toMatchObject({ impressionCount: 13, clickCount: 3 });
    });
  });

  it("creates a badge row for a listing that never registered one", async () => {
    // The SVG route serves any published listing, badge row or not, so the
    // flush is where most rows first appear.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      await applyBadgeCounters(tx, ADMIN, [{ listingId, impressions: 4, clicks: 0 }]);

      const [row] = await tx.select().from(badges).where(eq(badges.listingId, listingId));
      expect(row).toMatchObject({ impressionCount: 4, clickCount: 0 });
    });
  });

  it("drops counters for ids that are not listings rather than throwing", async () => {
    // The keys come from a public URL. Rubbish in the hash must not take the
    // whole flush down with it — and a 500 here would leave the hash renamed
    // and the counts lost.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      const applied = await applyBadgeCounters(tx, ADMIN, [
        { listingId, impressions: 1, clicks: 0 },
        { listingId: "00000000-0000-4000-8000-00000000dead", impressions: 9, clicks: 9 },
        { listingId: "not-a-uuid", impressions: 9, clicks: 9 },
      ]);

      expect(applied).toBe(1);
      expect(await tx.select().from(badges)).toHaveLength(1);
    });
  });

  it("ignores empty and zero deltas", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      expect(await applyBadgeCounters(tx, ADMIN, [])).toBe(0);
      expect(await applyBadgeCounters(tx, ADMIN, [{ listingId, impressions: 0, clicks: 0 }])).toBe(0);
      expect(await tx.select().from(badges)).toHaveLength(0);
    });
  });

  it("is admin-only", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      await expect(applyBadgeCounters(tx, PUBLIC_VIEWER, [])).rejects.toThrow(/FORBIDDEN/);
    });
  });
});
