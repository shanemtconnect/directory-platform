import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { withTestDb, type TestDb } from "@/test/db";
import { badges, listings, profiles, user } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { makeListing, makeScaffold } from "@/test/factories";
import { ownerBadgeStatus } from "./badge-owner";

/**
 * The one read behind /advertise/badge/mine.
 *
 * Constraint 24: the QUERY scopes to what the viewer owns, so the page can
 * hand it any id at all and a stranger's listing simply does not match.
 */

/** A profiles row for a viewer, without dragging Better Auth into the test. */
async function makeProfile(tx: TestDb, viewer: Viewer & { role: "owner" }): Promise<string> {
  await tx.insert(user).values({
    id: viewer.userId, name: "Owner", email: `${viewer.userId}@example.com`,
  });
  const [row] = await tx.insert(profiles).values({ userId: viewer.userId }).returning({ id: profiles.id });
  return row!.id;
}

const OWNER: Viewer & { role: "owner" } = { role: "owner", userId: `u-${randomUUID()}` };
const STRANGER: Viewer & { role: "owner" } = { role: "owner", userId: `u-${randomUUID()}` };

describe("ownerBadgeStatus", () => {
  it("returns what the page needs for a listing the viewer owns, badge or no badge", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const profileId = await makeProfile(tx, OWNER);
      const id = await makeListing(tx, ctx, {
        name: "The Old Mill",
        ownerId: profileId,
        website: "https://www.client.example/",
        claimStatus: "verified",
        ratingAvg: "4.8",
        ratingCount: 27,
      });

      const before = await ownerBadgeStatus(tx, OWNER, id);
      expect(before).toMatchObject({
        id,
        name: "The Old Mill",
        path: "/leeds/the-old-mill",
        website: "https://www.client.example/",
        cityName: "Leeds",
        categoryName: "Barn Venues",
        claimStatus: "verified",
        ratingAvg: "4.8",
        ratingCount: 27,
        backlinkUrl: null,
        backlinkVerified: false,
        lastCheckedAt: null,
      });

      const checked = new Date("2026-09-12T12:00:00Z");
      await tx.insert(badges).values({
        listingId: id,
        backlinkUrl: "https://client.example/about",
        backlinkVerified: true,
        lastCheckedAt: checked,
      });

      const after = await ownerBadgeStatus(tx, OWNER, id);
      expect(after).toMatchObject({
        backlinkUrl: "https://client.example/about",
        backlinkVerified: true,
        lastCheckedAt: checked,
      });
    });
  });

  it("does not hide an owner's own unpublished listing", async () => {
    // The owner page is not a public page; a listing under review still needs
    // its owner to be able to see where they said the badge is.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const profileId = await makeProfile(tx, OWNER);
      const id = await makeListing(tx, ctx, { ownerId: profileId, website: "client.example" });
      await tx.update(listings).set({ status: "pending" }).where(eq(listings.id, id));

      expect((await ownerBadgeStatus(tx, OWNER, id))?.id).toBe(id);
    });
  });

  it("returns null for a listing the viewer does not own", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const ownerProfile = await makeProfile(tx, OWNER);
      await makeProfile(tx, STRANGER);
      const id = await makeListing(tx, ctx, { ownerId: ownerProfile });

      expect(await ownerBadgeStatus(tx, STRANGER, id)).toBeNull();
    });
  });

  it("returns null for a malformed id rather than throwing", async () => {
    await withTestDb(async (tx) => {
      await makeProfile(tx, OWNER);
      expect(await ownerBadgeStatus(tx, OWNER, "not-a-uuid")).toBeNull();
    });
  });

  it("refuses the public viewer", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx);
      await expect(ownerBadgeStatus(tx, PUBLIC_VIEWER, id)).rejects.toThrow(/FORBIDDEN/);
    });
  });
});
