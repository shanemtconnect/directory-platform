import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb, type TestDb } from "@/test/db";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { listings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { makeScaffold, makeListing, type ListingCtx } from "@/test/factories";
import {
  MAX_SHORTLIST_ITEMS,
  addListingToShortlist,
  countShortlistItems,
  createShortlistForCookie,
  findPublicShortlistByShareId,
  findShortlistByCookie,
  getOrCreateShortlistForCookie,
  listShortlistEntries,
  newShareId,
  removeListingFromShortlist,
  renameShortlistForCookie,
  setShortlistPublicForCookie,
} from "./shortlist";

const ADMIN: Viewer = { role: "admin", userId: "admin-1" };
const COOKIE = "cookie-aaaaaaaaaaaaaaaaaaaa";
const OTHER_COOKIE = "cookie-bbbbbbbbbbbbbbbbbbbb";

async function setup(tx: TestDb): Promise<{ ctx: ListingCtx; shortlistId: string }> {
  const ctx = await makeScaffold(tx);
  const list = await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
  return { ctx, shortlistId: list.id };
}

describe("shortlist ownership", () => {
  it("creates one list per cookie and finds it again", async () => {
    await withTestDb(async (tx) => {
      const created = await getOrCreateShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      const again = await getOrCreateShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      expect(again.id).toBe(created.id);
      const found = await findShortlistByCookie(tx, PUBLIC_VIEWER, COOKIE);
      expect(found?.id).toBe(created.id);
    });
  });

  it("does not hand another visitor's cookie the same list", async () => {
    await withTestDb(async (tx) => {
      const mine = await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      const theirs = await createShortlistForCookie(tx, PUBLIC_VIEWER, OTHER_COOKIE);
      expect(theirs.id).not.toBe(mine.id);
      expect(await findShortlistByCookie(tx, PUBLIC_VIEWER, OTHER_COOKIE)).toMatchObject({
        id: theirs.id,
      });
    });
  });

  it("returns null for an empty cookie rather than the first row in the table", async () => {
    await withTestDb(async (tx) => {
      await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      expect(await findShortlistByCookie(tx, PUBLIC_VIEWER, "")).toBeNull();
    });
  });
});

describe("shareId", () => {
  it("is long, unguessable and not a uuid", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = newShareId();
      expect(id.length).toBeGreaterThanOrEqual(32);
      // base64url only: no padding, nothing that needs escaping in a URL.
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id).not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      ids.add(id);
    }
    expect(ids.size).toBe(500);
  });

  it("differs between two lists created back to back", async () => {
    await withTestDb(async (tx) => {
      const a = await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      const b = await createShortlistForCookie(tx, PUBLIC_VIEWER, OTHER_COOKIE);
      expect(a.shareId).not.toBe(b.shareId);
    });
  });
});

describe("addListingToShortlist", () => {
  it("adds a published listing and returns it with its city and category", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const listingId = await makeListing(tx, ctx, {
        name: "The Old Barn",
        customFields: { capacity_seated: 120 },
      });

      expect(await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, listingId)).toEqual({
        ok: true,
      });

      const rows = await listShortlistEntries(tx, PUBLIC_VIEWER, shortlistId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        listingId,
        name: "The Old Barn",
        cityName: "Leeds",
        categoryName: "Barn Venues",
        customFields: { capacity_seated: 120 },
      });
      expect(rows[0]?.citySlug).toBeTruthy();
      expect(rows[0]?.slug).toBeTruthy();
    });
  });

  it("refuses an unpublished listing for the public", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const draft = await makeListing(tx, ctx, { status: "draft", name: "Not live yet" });

      expect(await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, draft)).toEqual({
        ok: false,
        reason: "not-found",
      });
      expect(await countShortlistItems(tx, PUBLIC_VIEWER, shortlistId)).toBe(0);
    });
  });

  it("refuses an unpublished listing for a signed-in non-admin too", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const pending = await makeListing(tx, ctx, { status: "pending" });
      const viewer: Viewer = { role: "owner", userId: "u1" };

      expect(await addListingToShortlist(tx, viewer, shortlistId, pending)).toEqual({
        ok: false,
        reason: "not-found",
      });
    });
  });

  it("returns not-found for a listing id that does not exist", async () => {
    await withTestDb(async (tx) => {
      const { shortlistId } = await setup(tx);
      expect(await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, randomUUID())).toEqual({
        ok: false,
        reason: "not-found",
      });
    });
  });

  it("treats a malformed id as a miss rather than throwing", async () => {
    await withTestDb(async (tx) => {
      const { shortlistId } = await setup(tx);
      expect(await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, "not-a-uuid")).toEqual({
        ok: false,
        reason: "not-found",
      });
      expect(await listShortlistEntries(tx, PUBLIC_VIEWER, "not-a-uuid")).toEqual([]);
    });
  });

  it("is idempotent — adding the same listing twice stores one row", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const listingId = await makeListing(tx, ctx);

      expect(await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, listingId)).toEqual({
        ok: true,
      });
      expect(await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, listingId)).toEqual({
        ok: false,
        reason: "duplicate",
      });
      expect(await countShortlistItems(tx, PUBLIC_VIEWER, shortlistId)).toBe(1);
    });
  });
});

describe("the 50-item cap", () => {
  it("stops at MAX_SHORTLIST_ITEMS and reports why", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);

      for (let i = 0; i < MAX_SHORTLIST_ITEMS; i++) {
        const id = await makeListing(tx, ctx, { name: `Listing number ${i}` });
        expect(await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, id)).toEqual({ ok: true });
      }
      expect(await countShortlistItems(tx, PUBLIC_VIEWER, shortlistId)).toBe(MAX_SHORTLIST_ITEMS);

      const overflow = await makeListing(tx, ctx, { name: "One too many" });
      expect(await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, overflow)).toEqual({
        ok: false,
        reason: "full",
      });
      expect(await countShortlistItems(tx, PUBLIC_VIEWER, shortlistId)).toBe(MAX_SHORTLIST_ITEMS);
    });
  });

  it("caps an admin's list too — the cap is about the table, not the viewer", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      for (let i = 0; i < MAX_SHORTLIST_ITEMS; i++) {
        const id = await makeListing(tx, ctx, { name: `Admin listing ${i}` });
        await addListingToShortlist(tx, ADMIN, shortlistId, id);
      }
      const overflow = await makeListing(tx, ctx, { name: "Admin one too many" });
      expect(await addListingToShortlist(tx, ADMIN, shortlistId, overflow)).toEqual({
        ok: false,
        reason: "full",
      });
    });
  });

  it("frees a slot again when an item is removed", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const ids: string[] = [];
      for (let i = 0; i < MAX_SHORTLIST_ITEMS; i++) {
        const id = await makeListing(tx, ctx, { name: `Full list ${i}` });
        ids.push(id);
        await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, id);
      }
      await removeListingFromShortlist(tx, PUBLIC_VIEWER, shortlistId, ids[0]!);
      const extra = await makeListing(tx, ctx, { name: "Replacement pick" });
      expect(await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, extra)).toEqual({
        ok: true,
      });
    });
  });
});

describe("listShortlistEntries visibility", () => {
  it("drops a listing that was unpublished after it was saved", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const stays = await makeListing(tx, ctx, { name: "Still live" });
      const goes = await makeListing(tx, ctx, { name: "Pulled later" });
      await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, stays);
      await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, goes);

      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, goes));

      const rows = await listShortlistEntries(tx, PUBLIC_VIEWER, shortlistId);
      expect(rows.map((r) => r.name)).toEqual(["Still live"]);
      // The row is still there; only the view of it is filtered.
      expect(await countShortlistItems(tx, PUBLIC_VIEWER, shortlistId)).toBe(2);
    });
  });

  it("drops a listing that was deleted outright", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const gone = await makeListing(tx, ctx, { name: "Deleted" });
      await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, gone);
      await tx.delete(listings).where(eq(listings.id, gone));

      expect(await listShortlistEntries(tx, PUBLIC_VIEWER, shortlistId)).toEqual([]);
    });
  });

  it("shows an unpublished saved listing to an admin", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const id = await makeListing(tx, ctx, { name: "Hidden from the public" });
      await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, id);
      await tx.update(listings).set({ status: "archived" }).where(eq(listings.id, id));

      expect(await listShortlistEntries(tx, PUBLIC_VIEWER, shortlistId)).toEqual([]);
      expect(await listShortlistEntries(tx, ADMIN, shortlistId)).toHaveLength(1);
    });
  });

  it("keeps insertion order", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      for (const name of ["First pick", "Second pick", "Third pick"]) {
        const id = await makeListing(tx, ctx, { name });
        await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, id);
      }
      const rows = await listShortlistEntries(tx, PUBLIC_VIEWER, shortlistId);
      expect(rows.map((r) => r.name)).toEqual(["First pick", "Second pick", "Third pick"]);
    });
  });
});

describe("removeListingFromShortlist", () => {
  it("removes the row and leaves the rest alone", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const a = await makeListing(tx, ctx, { name: "Keep this" });
      const b = await makeListing(tx, ctx, { name: "Drop this" });
      await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, a);
      await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, b);

      await removeListingFromShortlist(tx, PUBLIC_VIEWER, shortlistId, b);
      const rows = await listShortlistEntries(tx, PUBLIC_VIEWER, shortlistId);
      expect(rows.map((r) => r.name)).toEqual(["Keep this"]);
    });
  });

  it("does not touch another visitor's list", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const theirs = await createShortlistForCookie(tx, PUBLIC_VIEWER, OTHER_COOKIE);
      const listingId = await makeListing(tx, ctx, { name: "Saved by both" });
      await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, listingId);
      await addListingToShortlist(tx, PUBLIC_VIEWER, theirs.id, listingId);

      await removeListingFromShortlist(tx, PUBLIC_VIEWER, shortlistId, listingId);

      expect(await countShortlistItems(tx, PUBLIC_VIEWER, shortlistId)).toBe(0);
      expect(await countShortlistItems(tx, PUBLIC_VIEWER, theirs.id)).toBe(1);
    });
  });
});

describe("the public shared view", () => {
  it("404s a private list even when the shareId is exactly right", async () => {
    await withTestDb(async (tx) => {
      const list = await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      expect(list.isPublic).toBe(false);
      expect(
        await findPublicShortlistByShareId(tx, PUBLIC_VIEWER, list.shareId),
      ).toBeNull();
    });
  });

  it("404s a private list for an admin as well — private means private", async () => {
    await withTestDb(async (tx) => {
      const list = await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      expect(await findPublicShortlistByShareId(tx, ADMIN, list.shareId)).toBeNull();
    });
  });

  it("resolves once the owner shares it, and stops again when they unshare", async () => {
    await withTestDb(async (tx) => {
      const list = await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);

      await setShortlistPublicForCookie(tx, PUBLIC_VIEWER, COOKIE, true);
      expect(await findPublicShortlistByShareId(tx, PUBLIC_VIEWER, list.shareId)).toMatchObject({
        id: list.id,
        isPublic: true,
      });

      await setShortlistPublicForCookie(tx, PUBLIC_VIEWER, COOKIE, false);
      expect(await findPublicShortlistByShareId(tx, PUBLIC_VIEWER, list.shareId)).toBeNull();
    });
  });

  it("does not resolve a near-miss shareId", async () => {
    await withTestDb(async (tx) => {
      const list = await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      await setShortlistPublicForCookie(tx, PUBLIC_VIEWER, COOKIE, true);

      expect(await findPublicShortlistByShareId(tx, PUBLIC_VIEWER, list.shareId.slice(0, -1))).toBeNull();
      expect(await findPublicShortlistByShareId(tx, PUBLIC_VIEWER, "")).toBeNull();
    });
  });

  it("hides unpublished listings from the shared view too", async () => {
    await withTestDb(async (tx) => {
      const { ctx, shortlistId } = await setup(tx);
      const live = await makeListing(tx, ctx, { name: "Public pick" });
      const dead = await makeListing(tx, ctx, { name: "Pulled pick" });
      await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, live);
      await addListingToShortlist(tx, PUBLIC_VIEWER, shortlistId, dead);
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, dead));
      await setShortlistPublicForCookie(tx, PUBLIC_VIEWER, COOKIE, true);

      const rows = await listShortlistEntries(tx, PUBLIC_VIEWER, shortlistId);
      expect(rows.map((r) => r.name)).toEqual(["Public pick"]);
    });
  });
});

describe("rename and share are scoped by cookie", () => {
  it("renames the caller's own list", async () => {
    await withTestDb(async (tx) => {
      await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      const row = await renameShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE, "  Weekend picks  ");
      expect(row?.name).toBe("Weekend picks");
    });
  });

  it("stores an all-whitespace name as null rather than a blank heading", async () => {
    await withTestDb(async (tx) => {
      await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      await renameShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE, "Something");
      const row = await renameShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE, "   ");
      expect(row?.name).toBeNull();
    });
  });

  it("truncates an over-long name instead of failing the write", async () => {
    await withTestDb(async (tx) => {
      await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);
      const row = await renameShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE, "x".repeat(500));
      expect(row?.name).toHaveLength(80);
    });
  });

  it("cannot rename or publish a list belonging to another cookie", async () => {
    await withTestDb(async (tx) => {
      const mine = await createShortlistForCookie(tx, PUBLIC_VIEWER, COOKIE);

      expect(await renameShortlistForCookie(tx, PUBLIC_VIEWER, OTHER_COOKIE, "Hijacked")).toBeNull();
      expect(await setShortlistPublicForCookie(tx, PUBLIC_VIEWER, OTHER_COOKIE, true)).toBeNull();

      const after = await findShortlistByCookie(tx, PUBLIC_VIEWER, COOKIE);
      expect(after).toMatchObject({ id: mine.id, name: null, isPublic: false });
    });
  });
});
