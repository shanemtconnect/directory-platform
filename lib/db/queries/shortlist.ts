import { randomBytes } from "node:crypto";
import { and, asc, eq, sql, count } from "drizzle-orm";
import {
  categories, cities, listings, shortlistItems, shortlists,
} from "@/lib/db/schema";
import { publicListingColumns, publishedListings } from "@/lib/db/queries/listings";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

/**
 * Shortlists — the logged-out path is the point.
 *
 * There is no auth in this codebase yet, so a shortlist is owned by an
 * httpOnly cookie value and nothing else. That has two consequences this
 * module has to carry:
 *
 *  1. The cookie value IS the credential. Every mutation is scoped by
 *     `cookieId` as well as by shortlist id, so knowing a shortlist's uuid
 *     buys nothing.
 *  2. Anyone on the internet can create rows here without signing in, so the
 *     item count is capped in SQL (see MAX_SHORTLIST_ITEMS) rather than in a
 *     component that a direct action call would skip.
 *
 * As everywhere else in lib/db/queries, every exported function takes an
 * explicit `viewer` and applies its own published-listing filter. There is no
 * RLS behind this — the data layer is the only gate.
 */

/**
 * An unauthenticated list that can grow forever is a cheap way to fill the
 * table. Fifty is well past the point where a comparison table is useful.
 */
export const MAX_SHORTLIST_ITEMS = 50;

/** Name is display-only; a long one just breaks the layout. */
export const MAX_SHORTLIST_NAME = 80;

/**
 * Lives here rather than in lib/actions/shortlist.ts because a "use server"
 * module may only export async functions, and both the actions and the page
 * that reads the cookie need this name.
 */
export const SHORTLIST_COOKIE = "dp_shortlist";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id must be a miss, not a 22P02 from a ::uuid cast. */
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/**
 * 192 bits from the CSPRNG, base64url so it is URL- and cookie-safe.
 *
 * Deliberately stronger than randomUUID(): a v4 uuid carries 122 bits and,
 * more to the point, looks like a database id — a share link is the only thing
 * standing between a public list and everyone else's, so it should not be
 * guessable, enumerable, or mistakable for a row id.
 */
function token(): string {
  return randomBytes(24).toString("base64url");
}

export const newShareId = token;
export const newCookieId = token;

export interface ShortlistRow {
  id: string;
  name: string | null;
  shareId: string;
  isPublic: boolean;
}

const shortlistColumns = {
  id: shortlists.id,
  name: shortlists.name,
  shareId: shortlists.shareId,
  isPublic: shortlists.isPublic,
} as const;

export interface ShortlistEntry {
  itemId: string;
  listingId: string;
  name: string;
  slug: string;
  citySlug: string;
  cityName: string;
  categoryName: string;
  tier: (typeof listings.$inferSelect)["tier"];
  shortDescription: string | null;
  customFields: Record<string, unknown> | null;
  note: string | null;
  sortOrder: number;
}

/** The visitor's own list, found by the cookie they are carrying. */
export async function findShortlistByCookie(
  tx: TestDb,
  _viewer: Viewer,
  cookieId: string,
): Promise<ShortlistRow | null> {
  if (!cookieId) return null;
  const [row] = await tx
    .select(shortlistColumns)
    .from(shortlists)
    .where(eq(shortlists.cookieId, cookieId))
    .limit(1);
  return row ?? null;
}

export async function createShortlistForCookie(
  tx: TestDb,
  _viewer: Viewer,
  cookieId: string,
): Promise<ShortlistRow> {
  const [row] = await tx
    .insert(shortlists)
    .values({ cookieId, shareId: newShareId(), isPublic: false })
    .returning(shortlistColumns);
  // The insert has no conditional clause, so a missing row is impossible.
  return row!;
}

export async function getOrCreateShortlistForCookie(
  tx: TestDb,
  viewer: Viewer,
  cookieId: string,
): Promise<ShortlistRow> {
  const existing = await findShortlistByCookie(tx, viewer, cookieId);
  return existing ?? createShortlistForCookie(tx, viewer, cookieId);
}

/**
 * The public shared view's only entry point.
 *
 * `isPublic` is part of the WHERE clause and there is no admin bypass: a
 * private list must 404 for everybody who holds the link, including staff, or
 * "private" means "private until someone with a login is curious".
 */
export async function findPublicShortlistByShareId(
  tx: TestDb,
  _viewer: Viewer,
  shareId: string,
): Promise<ShortlistRow | null> {
  if (!shareId) return null;
  const [row] = await tx
    .select(shortlistColumns)
    .from(shortlists)
    .where(and(eq(shortlists.shareId, shareId), eq(shortlists.isPublic, true)))
    .limit(1);
  return row ?? null;
}

/**
 * The rows behind both views.
 *
 * Inner joins plus the visibility filter mean a listing that was unpublished,
 * archived or deleted after it was saved simply stops appearing. A shortlist
 * is a bag of pointers, not a snapshot — a stale pointer must never 404 the
 * whole page.
 */
export async function listShortlistEntries(
  tx: TestDb,
  viewer: Viewer,
  shortlistId: string,
): Promise<ShortlistEntry[]> {
  if (!isUuid(shortlistId)) return [];
  const rows = await tx
    .select({
      itemId: shortlistItems.id,
      listingId: listings.id,
      name: listings.name,
      slug: listings.slug,
      citySlug: cities.slug,
      cityName: cities.name,
      categoryName: categories.name,
      tier: listings.tier,
      shortDescription: listings.shortDescription,
      // The stripped projection, not the raw column: `custom_fields` carries a
      // `submission` blob (the submitter's email and IP) that no reader of a
      // shortlist may see.
      customFields: publicListingColumns.customFields,
      note: shortlistItems.note,
      sortOrder: shortlistItems.sortOrder,
    })
    .from(shortlistItems)
    .innerJoin(listings, eq(listings.id, shortlistItems.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .innerJoin(categories, eq(categories.id, listings.primaryCategoryId))
    .where(and(eq(shortlistItems.shortlistId, shortlistId), publishedListings(viewer)))
    .orderBy(asc(shortlistItems.sortOrder), asc(shortlistItems.createdAt));

  return rows.map((r) => ({
    ...r,
    customFields: (r.customFields ?? null) as Record<string, unknown> | null,
  }));
}

export async function countShortlistItems(
  tx: TestDb,
  _viewer: Viewer,
  shortlistId: string,
): Promise<number> {
  if (!isUuid(shortlistId)) return 0;
  const [row] = await tx
    .select({ n: count() })
    .from(shortlistItems)
    .where(eq(shortlistItems.shortlistId, shortlistId));
  return row?.n ?? 0;
}

export type AddResult =
  | { ok: true }
  | { ok: false; reason: "full" | "duplicate" | "not-found" };

/**
 * Add a listing, cap and visibility enforced inside one statement.
 *
 * The count check, the published check and the insert are a single SQL
 * statement on purpose: doing the count in JS and the insert afterwards lets
 * two concurrent submits from the same cookie both read 49 and both write.
 * `ON CONFLICT DO NOTHING` covers the duplicate case via the existing
 * (shortlist_id, listing_id) unique index.
 */
export async function addListingToShortlist(
  tx: TestDb,
  viewer: Viewer,
  shortlistId: string,
  listingId: string,
): Promise<AddResult> {
  if (!isUuid(shortlistId) || !isUuid(listingId)) return { ok: false, reason: "not-found" };

  const inserted = (await tx.execute(sql`
    insert into shortlist_items (shortlist_id, listing_id, sort_order)
    select
      ${shortlistId}::uuid,
      listings.id,
      coalesce(
        (select max(si.sort_order) + 1 from shortlist_items si
          where si.shortlist_id = ${shortlistId}::uuid),
        0
      )
    from listings
    where listings.id = ${listingId}::uuid
      and ${publishedListings(viewer)}
      and (
        select count(*) from shortlist_items si2
         where si2.shortlist_id = ${shortlistId}::uuid
      ) < ${MAX_SHORTLIST_ITEMS}
    on conflict (shortlist_id, listing_id) do nothing
    returning id
  `)) as unknown as unknown[];

  if (inserted.length > 0) return { ok: true };

  // Nothing was written. Work out which of the three reasons it was, so the UI
  // can say "your list is full" rather than a generic failure.
  const total = await countShortlistItems(tx, viewer, shortlistId);
  if (total >= MAX_SHORTLIST_ITEMS) return { ok: false, reason: "full" };

  const [dupe] = await tx
    .select({ id: shortlistItems.id })
    .from(shortlistItems)
    .where(and(
      eq(shortlistItems.shortlistId, shortlistId),
      eq(shortlistItems.listingId, listingId),
    ))
    .limit(1);
  if (dupe) return { ok: false, reason: "duplicate" };

  return { ok: false, reason: "not-found" };
}

/** Removing something that is not there is a success, not an error. */
export async function removeListingFromShortlist(
  tx: TestDb,
  _viewer: Viewer,
  shortlistId: string,
  listingId: string,
): Promise<void> {
  if (!isUuid(shortlistId) || !isUuid(listingId)) return;
  await tx
    .delete(shortlistItems)
    .where(and(
      eq(shortlistItems.shortlistId, shortlistId),
      eq(shortlistItems.listingId, listingId),
    ));
}

/**
 * Mutations are scoped by cookieId as well as by id. The shortlist uuid is not
 * a secret — it travels in the page's own markup — so it must not be enough on
 * its own to rename or publish someone else's list.
 */
export async function renameShortlistForCookie(
  tx: TestDb,
  _viewer: Viewer,
  cookieId: string,
  name: string,
): Promise<ShortlistRow | null> {
  const trimmed = name.trim().slice(0, MAX_SHORTLIST_NAME);
  const [row] = await tx
    .update(shortlists)
    .set({ name: trimmed.length > 0 ? trimmed : null, updatedAt: new Date() })
    .where(eq(shortlists.cookieId, cookieId))
    .returning(shortlistColumns);
  return row ?? null;
}

export async function setShortlistPublicForCookie(
  tx: TestDb,
  _viewer: Viewer,
  cookieId: string,
  isPublic: boolean,
): Promise<ShortlistRow | null> {
  const [row] = await tx
    .update(shortlists)
    .set({ isPublic, updatedAt: new Date() })
    .where(eq(shortlists.cookieId, cookieId))
    .returning(shortlistColumns);
  return row ?? null;
}
