import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import * as schema from "@/lib/db/schema";
import {
  auditLog, categories, cities, listingImages, listings, profiles, slugs, user, verticals,
} from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import type { Viewer } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { listingPaths } from "./paths";
import {
  createOwnerPhoto,
  deleteOwnerPhoto,
  ownerPhotoQuota,
  ownerPhotos,
  reorderOwnerPhotos,
  setOwnerPhotoAlt,
} from "./photos";

async function owner(tx: TestDb, role: "user" | "owner" | "admin" = "owner") {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({
    id: userId, name: "Jo", email: `${userId}@example.test`, emailVerified: true,
  });
  const [profile] = await tx.insert(profiles).values({ userId, role }).returning({ id: profiles.id });
  return { userId, profileId: profile!.id, viewer: { role, userId } as Viewer };
}

async function owned(tx: TestDb, patch: Record<string, unknown> = {}) {
  const ctx = await makeScaffold(tx);
  const jo = await owner(tx);
  const listingId = await makeListing(tx, ctx, {
    name: "The Old Mill", ownerId: jo.profileId, claimStatus: "claimed", ...patch,
  });
  return { ...jo, listingId, ctx };
}

const key = (listingId: string, n: number) =>
  `listings/${listingId}/photo-${n.toString(16).padStart(16, "0")}.jpg`;

const IP = "203.0.113.7";

describe("ownerPhotoQuota", () => {
  it("reports the tier's cap and how much of it is used", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx, { tier: "free" });
      expect(await ownerPhotoQuota(tx, jo.viewer, jo.listingId)).toEqual({
        used: 0, max: siteConfig.tiers.free.maxImages, tier: "free",
      });
    });
  });

  it("is null for somebody else's listing and for a non-uuid", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const stranger = await owner(tx);
      expect(await ownerPhotoQuota(tx, stranger.viewer, jo.listingId)).toBeNull();
      expect(await ownerPhotoQuota(tx, jo.viewer, "nope")).toBeNull();
    });
  });

  it("refuses an anonymous viewer outright", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      await expect(ownerPhotoQuota(tx, { role: "public" }, jo.listingId)).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("createOwnerPhoto", () => {
  it("inserts a pending row, makes the first image the hero and writes an audit row with the ip", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const result = await createOwnerPhoto(tx, jo.viewer, {
        listingId: jo.listingId, storagePath: key(jo.listingId, 1), ip: IP,
      });
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      expect(result.paths).toEqual(await listingPaths(tx, ADMIN_VIEWER, jo.listingId));

      const [row] = await tx.select().from(listingImages).where(eq(listingImages.id, result.id));
      expect(row?.derivatives).toBeNull();
      expect(row?.isPrimary).toBe(true);
      expect(row?.sortOrder).toBe(0);

      const [audit] = await tx.select().from(auditLog).where(eq(auditLog.entityId, result.id));
      expect(audit?.action).toBe("photo.uploaded");
      expect(audit?.ip).toBe(IP);
      expect(audit?.actorId).toBe(jo.profileId);
      expect(audit?.meta).toEqual({ listingId: jo.listingId });
      // Never the key: the audit row outlives the object and must not be a
      // second place to find an unprocessed original.
      expect(JSON.stringify(audit)).not.toContain("photo-");
    });
  });

  it("appends after the existing images, which keep their hero", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const a = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 1), ip: IP });
      const b = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 2), ip: IP });
      expect(a.outcome).toBe("created");
      expect(b.outcome).toBe("created");
      const rows = await ownerPhotos(tx, jo.viewer, jo.listingId);
      expect(rows.map((r) => [r.sortOrder, r.isPrimary, r.status])).toEqual([
        [0, true, "pending"], [1, false, "pending"],
      ]);
    });
  });

  it("enforces the tier's cap inside the transaction", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx, { tier: "free" });
      const max = siteConfig.tiers.free.maxImages!;
      for (let n = 0; n < max; n++) {
        const r = await createOwnerPhoto(tx, jo.viewer, {
          listingId: jo.listingId, storagePath: key(jo.listingId, n), ip: IP,
        });
        expect(r.outcome).toBe("created");
      }
      const over = await createOwnerPhoto(tx, jo.viewer, {
        listingId: jo.listingId, storagePath: key(jo.listingId, 99), ip: IP,
      });
      expect(over).toEqual({ outcome: "limit", max });
      expect(await ownerPhotoQuota(tx, jo.viewer, jo.listingId)).toMatchObject({ used: max, max });
    });
  });

  it("has no cap on a tier whose maxImages is null", async () => {
    await withTestDb(async (tx) => {
      expect(siteConfig.tiers.premium.maxImages).toBeNull();
      const jo = await owned(tx, { tier: "premium" });
      for (let n = 0; n < 12; n++) {
        const r = await createOwnerPhoto(tx, jo.viewer, {
          listingId: jo.listingId, storagePath: key(jo.listingId, n), ip: IP,
        });
        expect(r.outcome).toBe("created");
      }
      expect(await ownerPhotoQuota(tx, jo.viewer, jo.listingId)).toEqual({
        used: 12, max: null, tier: "premium",
      });
    });
  });

  it("refuses a key outside listings/<id>/ even from the owner", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const other = randomUUID();
      const bad = await createOwnerPhoto(tx, jo.viewer, {
        listingId: jo.listingId, storagePath: key(other, 1), ip: IP,
      });
      expect(bad).toEqual({ outcome: "bad-key" });
      expect(await tx.select().from(listingImages)).toHaveLength(0);
    });
  });

  it("is not-found for somebody else's listing, and writes nothing", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const stranger = await owner(tx);
      const r = await createOwnerPhoto(tx, stranger.viewer, {
        listingId: jo.listingId, storagePath: key(jo.listingId, 1), ip: IP,
      });
      expect(r).toEqual({ outcome: "not-found" });
      expect(await tx.select().from(listingImages)).toHaveLength(0);
      expect(await tx.select().from(auditLog)).toHaveLength(0);
    });
  });
});

describe("ownerPhotos", () => {
  it("says which rows the worker has finished and which it gave up on", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const a = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 1), ip: IP });
      const b = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 2), ip: IP });
      const c = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 3), ip: IP });
      if (a.outcome !== "created" || b.outcome !== "created" || c.outcome !== "created") throw new Error();
      await tx.update(listingImages).set({
        derivatives: { thumb: "t", card: "c", hero: "h", full: "f" }, width: 2000, height: 1000,
      }).where(eq(listingImages.id, a.id));
      await tx.update(listingImages).set({ derivativesAttempts: 5, derivativesError: "boom" })
        .where(eq(listingImages.id, b.id));

      const rows = await ownerPhotos(tx, jo.viewer, jo.listingId);
      expect(rows.map((r) => r.status)).toEqual(["live", "failed", "pending"]);
      expect(rows[0]?.thumbPath).toBe("t");
      expect(rows[1]?.thumbPath).toBeNull();
      // The operator's error string stays out of the owner's page.
      expect(JSON.stringify(rows)).not.toContain("boom");
    });
  });

  it("returns nothing for a stranger, rather than the listing's photos", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 1), ip: IP });
      const stranger = await owner(tx);
      expect(await ownerPhotos(tx, stranger.viewer, jo.listingId)).toEqual([]);
    });
  });
});

describe("reorderOwnerPhotos", () => {
  it("renumbers in the order given and moves the hero to the first", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const ids: string[] = [];
      for (let n = 0; n < 3; n++) {
        const r = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, n), ip: IP });
        if (r.outcome !== "created") throw new Error();
        ids.push(r.id);
      }
      const result = await reorderOwnerPhotos(tx, jo.viewer, jo.listingId, [ids[2]!, ids[0]!, ids[1]!], IP);
      expect(result.outcome).toBe("saved");
      const rows = await ownerPhotos(tx, jo.viewer, jo.listingId);
      expect(rows.map((r) => r.id)).toEqual([ids[2], ids[0], ids[1]]);
      expect(rows.map((r) => r.isPrimary)).toEqual([true, false, false]);
      const [audit] = await tx.select().from(auditLog).where(eq(auditLog.action, "photo.reordered"));
      expect(audit?.entityId).toBe(jo.listingId);
      expect(audit?.ip).toBe(IP);
    });
  });

  it("refuses a list that is not exactly the listing's own photos", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const a = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 1), ip: IP });
      const b = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 2), ip: IP });
      if (a.outcome !== "created" || b.outcome !== "created") throw new Error();
      // Missing one, a stranger's id, a duplicate: all refused, nothing moves.
      expect(await reorderOwnerPhotos(tx, jo.viewer, jo.listingId, [a.id], IP)).toEqual({ outcome: "mismatch" });
      expect(await reorderOwnerPhotos(tx, jo.viewer, jo.listingId, [a.id, randomUUID()], IP)).toEqual({ outcome: "mismatch" });
      expect(await reorderOwnerPhotos(tx, jo.viewer, jo.listingId, [b.id, b.id], IP)).toEqual({ outcome: "mismatch" });
      const rows = await ownerPhotos(tx, jo.viewer, jo.listingId);
      expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    });
  });

  it("is not-found for a stranger", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const a = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 1), ip: IP });
      if (a.outcome !== "created") throw new Error();
      const stranger = await owner(tx);
      expect(await reorderOwnerPhotos(tx, stranger.viewer, jo.listingId, [a.id], IP)).toEqual({ outcome: "not-found" });
    });
  });
});

describe("setOwnerPhotoAlt", () => {
  it("saves trimmed alt text on the owner's own photo and audits it", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const a = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 1), ip: IP });
      if (a.outcome !== "created") throw new Error();
      const r = await setOwnerPhotoAlt(tx, jo.viewer, a.id, "  The front door  ", IP);
      expect(r.outcome).toBe("saved");
      if (r.outcome === "saved") expect(r.listingId).toBe(jo.listingId);
      const [row] = await ownerPhotos(tx, jo.viewer, jo.listingId);
      expect(row?.alt).toBe("The front door");
      const [audit] = await tx.select().from(auditLog).where(eq(auditLog.action, "photo.alt_saved"));
      expect(audit?.entityId).toBe(a.id);
      expect(audit?.ip).toBe(IP);
    });
  });

  it("stores empty alt as null and refuses a stranger", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const a = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 1), ip: IP });
      if (a.outcome !== "created") throw new Error();
      await setOwnerPhotoAlt(tx, jo.viewer, a.id, "   ", IP);
      const [row] = await ownerPhotos(tx, jo.viewer, jo.listingId);
      expect(row?.alt).toBeNull();
      const stranger = await owner(tx);
      expect(await setOwnerPhotoAlt(tx, stranger.viewer, a.id, "Mine now", IP)).toEqual({ outcome: "not-found" });
    });
  });
});

describe("deleteOwnerPhoto", () => {
  it("removes the row, hands back every key to delete, closes the gap and promotes a new hero", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const ids: string[] = [];
      for (let n = 0; n < 3; n++) {
        const r = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, n), ip: IP });
        if (r.outcome !== "created") throw new Error();
        ids.push(r.id);
      }
      await tx.update(listingImages).set({
        derivatives: { thumb: "t", card: "c", hero: "h", full: "f" },
      }).where(eq(listingImages.id, ids[0]!));

      const result = await deleteOwnerPhoto(tx, jo.viewer, ids[0]!, IP);
      expect(result.outcome).toBe("deleted");
      if (result.outcome !== "deleted") return;
      expect([...result.keys].sort()).toEqual([key(jo.listingId, 0), "c", "f", "h", "t"].sort());
      expect(result.paths).toEqual(await listingPaths(tx, ADMIN_VIEWER, jo.listingId));

      const rows = await ownerPhotos(tx, jo.viewer, jo.listingId);
      expect(rows.map((r) => [r.id, r.sortOrder, r.isPrimary])).toEqual([
        [ids[1], 0, true], [ids[2], 1, false],
      ]);
      const [audit] = await tx.select().from(auditLog).where(eq(auditLog.action, "photo.deleted"));
      expect(audit?.entityId).toBe(ids[0]);
      expect(audit?.ip).toBe(IP);
      expect(audit?.meta).toEqual({ listingId: jo.listingId });
      expect(result.listingId).toBe(jo.listingId);
    });
  });

  it("is not-found for a stranger and for a non-uuid, and deletes nothing", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const a = await createOwnerPhoto(tx, jo.viewer, { listingId: jo.listingId, storagePath: key(jo.listingId, 1), ip: IP });
      if (a.outcome !== "created") throw new Error();
      const stranger = await owner(tx);
      expect(await deleteOwnerPhoto(tx, stranger.viewer, a.id, IP)).toEqual({ outcome: "not-found" });
      expect(await deleteOwnerPhoto(tx, jo.viewer, "nope", IP)).toEqual({ outcome: "not-found" });
      expect(await ownerPhotos(tx, jo.viewer, jo.listingId)).toHaveLength(1);
    });
  });
});

/**
 * The one test in this file that cannot use the rollback harness.
 *
 * Two confirms have to be in flight AT THE SAME TIME against COMMITTED rows
 * for the listing lock to mean anything, and `withTestDb` gives one
 * transaction that is thrown away. So this opens its own connections, commits
 * an owner and a free-tier listing, races two confirms at `max - 1` and
 * cleans up after itself.
 */
describe("createOwnerPhoto concurrency", () => {
  const url =
    process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
  const client = postgres(url, { max: 4 });
  const database = drizzle(client, { schema }) as unknown as TestDb;
  /** What the test committed, deleted in dependency order. */
  const made = { userId: "", profileId: "", listingId: "", ctx: null as ListingCtx | null };

  afterAll(async () => {
    const { userId, profileId, listingId, ctx } = made;
    if (profileId) await database.delete(auditLog).where(eq(auditLog.actorId, profileId));
    if (listingId) await database.delete(listings).where(eq(listings.id, listingId));
    if (ctx) {
      await database.delete(slugs).where(eq(slugs.parentScope, ctx.cityId));
      await database.delete(slugs).where(
        inArray(slugs.entityId, [listingId, ctx.cityId, ctx.primaryCategoryId, ctx.verticalId]),
      );
      await database.delete(categories).where(eq(categories.id, ctx.primaryCategoryId));
      await database.delete(cities).where(eq(cities.id, ctx.cityId));
      await database.delete(verticals).where(eq(verticals.id, ctx.verticalId));
    }
    if (userId) await database.delete(user).where(eq(user.id, userId));
    await client.end({ timeout: 5 });
  });

  it("lets exactly one of two simultaneous confirms through at the cap", async () => {
    const max = siteConfig.tiers.free.maxImages!;
    const jo = await owner(database);
    made.userId = jo.userId;
    made.profileId = jo.profileId;
    const ctx = await makeScaffold(database);
    made.ctx = ctx;
    const listingId = await makeListing(database, ctx, {
      name: "Race", tier: "free", ownerId: jo.profileId, claimStatus: "claimed",
    });
    made.listingId = listingId;

    for (let n = 0; n < max - 1; n++) {
      const r = await createOwnerPhoto(database, jo.viewer, {
        listingId, storagePath: key(listingId, n), ip: IP,
      });
      expect(r.outcome).toBe("created");
    }

    const attempt = (n: number) =>
      database.transaction(async (tx) =>
        createOwnerPhoto(tx as unknown as TestDb, jo.viewer, {
          listingId, storagePath: key(listingId, 100 + n), ip: IP,
        }),
      );
    const [a, b] = await Promise.all([attempt(1), attempt(2)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["created", "limit"]);

    const rows = await database
      .select({ sortOrder: listingImages.sortOrder, isPrimary: listingImages.isPrimary })
      .from(listingImages)
      .where(eq(listingImages.listingId, listingId))
      .orderBy(asc(listingImages.sortOrder));
    expect(rows).toHaveLength(max);
    expect(rows.map((r) => r.sortOrder)).toEqual([...Array(max).keys()]);
    expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);
  });
});
