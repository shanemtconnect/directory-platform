import { and, asc, eq, sql } from "drizzle-orm";
import { listingImages, listings } from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import { now } from "@/lib/clock";
import { isListingPhotoKey } from "@/lib/media/listing-photos";
import { MAX_DERIVATIVE_ATTEMPTS } from "@/worker/jobs/derivatives";
import type { Viewer } from "@/lib/db/viewer";
import type { Db } from "@/lib/db/client";
import { writeAudit } from "./audit";
import { ownedByViewer } from "./owner";
import { resolveListingPaths } from "./paths";

/**
 * The owner's photos: the `listing_images` rows behind the public gallery.
 *
 * Every function here scopes by the viewer's own profile through
 * `ownedByViewer`, the same predicate the rest of the owner portal uses
 * (global constraint 24): a photo id or a listing id from a form post that is
 * not the viewer's matches nothing. Every write lands an `audit_log` row in
 * the same transaction, with the request address (constraint 22).
 *
 * A row's lifecycle is the worker's: inserted here with no `derivatives`
 * ("pending"), filled in by worker/jobs/derivatives.ts once the bytes have
 * been sniffed and resized ("live"), or abandoned after MAX_DERIVATIVE_ATTEMPTS
 * ("failed"). The public gallery renders live rows only; the owner's page
 * shows all three states so a stuck upload is not a mystery.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSignedIn(viewer: Viewer): asserts viewer is Exclude<Viewer, { role: "public" }> {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

export type PhotoStatus = "pending" | "live" | "failed";

export interface OwnerPhoto {
  id: string;
  /** The thumbnail's key, once the worker has made one; null while pending or failed. */
  thumbPath: string | null;
  alt: string | null;
  sortOrder: number;
  isPrimary: boolean;
  status: PhotoStatus;
}

export interface PhotoQuota {
  used: number;
  /** The tier's `maxImages`; null means unlimited. */
  max: number | null;
  tier: "free" | "essential" | "premium";
}

/**
 * The listing's id and tier, if the viewer owns it. The gate every write
 * starts with.
 *
 * `lock: true` takes the row FOR UPDATE, and that is the concurrency control
 * for everything below: the tier cap is a count-then-insert, and reorder and
 * delete are read-then-renumber loops. Under READ COMMITTED two confirms at
 * `max - 1` would each count `max - 1` and both insert; with the listing row
 * locked the second waits for the first to commit and then counts `max`.
 * Reads never lock.
 */
async function ownedListing(
  tx: Db,
  viewer: Exclude<Viewer, { role: "public" }>,
  listingId: string,
  opts: { lock: boolean } = { lock: false },
): Promise<{ id: string; tier: PhotoQuota["tier"] } | null> {
  if (!UUID.test(listingId)) return null;
  const query = tx
    .select({ id: listings.id, tier: listings.tier })
    .from(listings)
    .where(and(eq(listings.id, listingId), ownedByViewer(viewer)))
    .limit(1);
  const [row] = await (opts.lock ? query.for("update") : query);
  return row ?? null;
}

async function countImages(tx: Db, listingId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(listingImages)
    .where(eq(listingImages.listingId, listingId));
  return row?.n ?? 0;
}

export async function ownerPhotoQuota(
  tx: Db,
  viewer: Viewer,
  listingId: string,
): Promise<PhotoQuota | null> {
  assertSignedIn(viewer);
  const listing = await ownedListing(tx, viewer, listingId);
  if (!listing) return null;
  return {
    used: await countImages(tx, listing.id),
    max: siteConfig.tiers[listing.tier].maxImages,
    tier: listing.tier,
  };
}

/** The status the worker's columns imply. Never the error string: that is for an operator. */
function statusOf(row: {
  derivatives: unknown;
  derivativesAttempts: number;
}): PhotoStatus {
  if (row.derivatives !== null) return "live";
  if (row.derivativesAttempts >= MAX_DERIVATIVE_ATTEMPTS) return "failed";
  return "pending";
}

function thumbOf(derivatives: unknown): string | null {
  if (typeof derivatives !== "object" || derivatives === null) return null;
  const thumb = (derivatives as Record<string, unknown>).thumb;
  return typeof thumb === "string" ? thumb : null;
}

export async function ownerPhotos(tx: Db, viewer: Viewer, listingId: string): Promise<OwnerPhoto[]> {
  assertSignedIn(viewer);
  if (!UUID.test(listingId)) return [];
  const rows = await tx
    .select({
      id: listingImages.id,
      derivatives: listingImages.derivatives,
      derivativesAttempts: listingImages.derivativesAttempts,
      alt: listingImages.alt,
      sortOrder: listingImages.sortOrder,
      isPrimary: listingImages.isPrimary,
    })
    .from(listingImages)
    .innerJoin(listings, eq(listings.id, listingImages.listingId))
    .where(and(eq(listingImages.listingId, listingId), ownedByViewer(viewer)))
    .orderBy(asc(listingImages.sortOrder), asc(listingImages.createdAt));
  return rows.map((r) => ({
    id: r.id,
    thumbPath: thumbOf(r.derivatives),
    alt: r.alt,
    sortOrder: r.sortOrder,
    isPrimary: r.isPrimary,
    status: statusOf(r),
  }));
}

export type CreatePhotoResult =
  | { outcome: "created"; id: string; paths: string[] }
  | { outcome: "not-found" }
  | { outcome: "bad-key" }
  | { outcome: "limit"; max: number };

/**
 * Records where an upload landed, once the browser's POST to R2 succeeded.
 *
 * The cap is checked HERE, with the listing row locked, not only in the
 * action that signed the upload: two tabs can each be told "2 of 3 used" and
 * both confirm, and without the lock both would pass. The key is checked against the one shape the server
 * mints for THIS listing — a row pointing at another listing's object would
 * serve their photo under this name once the worker had processed it.
 */
export async function createOwnerPhoto(
  tx: Db,
  viewer: Viewer,
  input: { listingId: string; storagePath: string; ip: string | null },
): Promise<CreatePhotoResult> {
  assertSignedIn(viewer);
  const listing = await ownedListing(tx, viewer, input.listingId, { lock: true });
  if (!listing) return { outcome: "not-found" };
  if (!isListingPhotoKey(listing.id.toLowerCase(), input.storagePath)) return { outcome: "bad-key" };

  const max = siteConfig.tiers[listing.tier].maxImages;
  const used = await countImages(tx, listing.id);
  if (max !== null && used >= max) return { outcome: "limit", max };

  const at = now();
  const [row] = await tx
    .insert(listingImages)
    .values({
      listingId: listing.id,
      storagePath: input.storagePath,
      sortOrder: used,
      // The first photo is the hero. Every later one waits its turn.
      isPrimary: used === 0,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: listingImages.id });

  // The original's key is deliberately NOT in the audit row. Until the worker
  // has run it is a phone photo with its EXIF intact in a public bucket; the
  // row already holds the key for as long as that is true, and an audit
  // trail that outlives the object should not be a second place to find it.
  await writeAudit(tx, viewer, {
    action: "photo.uploaded",
    entityType: "listing_image",
    entityId: row!.id,
    meta: { listingId: listing.id },
    ip: input.ip,
  });

  return { outcome: "created", id: row!.id, paths: await resolveListingPaths(tx, listing.id) };
}

export type ReorderResult =
  | { outcome: "saved"; paths: string[] }
  | { outcome: "not-found" }
  | { outcome: "mismatch" };

/**
 * The new order, as the complete list of the listing's photo ids.
 *
 * The whole list rather than one move, so the form and the row cannot
 * disagree about what "third" means; and exactly the listing's own ids, once
 * each, so a stale page — one that has since had a photo deleted or added in
 * another tab — is refused rather than silently renumbered around.
 */
export async function reorderOwnerPhotos(
  tx: Db,
  viewer: Viewer,
  listingId: string,
  orderedIds: readonly string[],
  ip: string | null,
): Promise<ReorderResult> {
  assertSignedIn(viewer);
  const listing = await ownedListing(tx, viewer, listingId, { lock: true });
  if (!listing) return { outcome: "not-found" };

  const current = await tx
    .select({ id: listingImages.id })
    .from(listingImages)
    .where(eq(listingImages.listingId, listing.id));
  const have = new Set(current.map((r) => r.id));
  const want = new Set(orderedIds);
  if (want.size !== orderedIds.length || want.size !== have.size) return { outcome: "mismatch" };
  for (const id of want) if (!have.has(id)) return { outcome: "mismatch" };

  const at = now();
  for (const [index, id] of orderedIds.entries()) {
    await tx
      .update(listingImages)
      .set({ sortOrder: index, isPrimary: index === 0, updatedAt: at })
      .where(and(eq(listingImages.id, id), eq(listingImages.listingId, listing.id)));
  }

  await writeAudit(tx, viewer, {
    action: "photo.reordered",
    entityType: "listing",
    entityId: listing.id,
    meta: { order: [...orderedIds] },
    ip,
  });

  return { outcome: "saved", paths: await resolveListingPaths(tx, listing.id) };
}

export type AltResult =
  | { outcome: "saved"; listingId: string; paths: string[] }
  | { outcome: "not-found" };

/** The photo's listing, if the viewer owns it. Photo ids are scoped the same way listing ids are. */
async function ownedPhoto(
  tx: Db,
  viewer: Exclude<Viewer, { role: "public" }>,
  photoId: string,
): Promise<{ id: string; listingId: string; storagePath: string; derivatives: unknown } | null> {
  if (!UUID.test(photoId)) return null;
  const [row] = await tx
    .select({
      id: listingImages.id,
      listingId: listingImages.listingId,
      storagePath: listingImages.storagePath,
      derivatives: listingImages.derivatives,
    })
    .from(listingImages)
    .innerJoin(listings, eq(listings.id, listingImages.listingId))
    .where(and(eq(listingImages.id, photoId), ownedByViewer(viewer)))
    .limit(1);
  return row ?? null;
}

export async function setOwnerPhotoAlt(
  tx: Db,
  viewer: Viewer,
  photoId: string,
  alt: string,
  ip: string | null,
): Promise<AltResult> {
  assertSignedIn(viewer);
  const photo = await ownedPhoto(tx, viewer, photoId);
  if (!photo) return { outcome: "not-found" };

  const trimmed = alt.trim();
  await tx
    .update(listingImages)
    .set({ alt: trimmed === "" ? null : trimmed, updatedAt: now() })
    .where(eq(listingImages.id, photo.id));

  await writeAudit(tx, viewer, {
    action: "photo.alt_saved",
    entityType: "listing_image",
    entityId: photo.id,
    meta: { listingId: photo.listingId },
    ip,
  });

  return {
    outcome: "saved",
    listingId: photo.listingId,
    paths: await resolveListingPaths(tx, photo.listingId),
  };
}

export type DeletePhotoResult =
  | {
      outcome: "deleted";
      listingId: string;
      /** The original and every derivative: what the action removes from the bucket once committed. */
      keys: string[];
      paths: string[];
    }
  | { outcome: "not-found" };

/**
 * Removes the row and says which objects are now orphans.
 *
 * The bucket is not touched here: this runs inside a transaction, and an
 * object deleted before a rollback is gone for good. The action deletes the
 * keys after the commit, best-effort — the row is the truth, and an orphan in
 * the bucket is a few kilobytes nobody can reach.
 */
export async function deleteOwnerPhoto(
  tx: Db,
  viewer: Viewer,
  photoId: string,
  ip: string | null,
): Promise<DeletePhotoResult> {
  assertSignedIn(viewer);
  const photo = await ownedPhoto(tx, viewer, photoId);
  if (!photo) return { outcome: "not-found" };
  // Serialises the renumbering below against a concurrent confirm or reorder.
  const listing = await ownedListing(tx, viewer, photo.listingId, { lock: true });
  if (!listing) return { outcome: "not-found" };

  const keys = [photo.storagePath];
  if (typeof photo.derivatives === "object" && photo.derivatives !== null) {
    for (const value of Object.values(photo.derivatives as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") keys.push(value);
    }
  }

  await tx.delete(listingImages).where(eq(listingImages.id, photo.id));

  // Close the gap and keep the first image the hero, whichever one that now is.
  const remaining = await tx
    .select({ id: listingImages.id })
    .from(listingImages)
    .where(eq(listingImages.listingId, photo.listingId))
    .orderBy(asc(listingImages.sortOrder), asc(listingImages.createdAt));
  const at = now();
  for (const [index, row] of remaining.entries()) {
    await tx
      .update(listingImages)
      .set({ sortOrder: index, isPrimary: index === 0, updatedAt: at })
      .where(eq(listingImages.id, row.id));
  }

  await writeAudit(tx, viewer, {
    action: "photo.deleted",
    entityType: "listing_image",
    entityId: photo.id,
    meta: { listingId: photo.listingId },
    ip,
  });

  return {
    outcome: "deleted",
    listingId: photo.listingId,
    keys,
    paths: await resolveListingPaths(tx, photo.listingId),
  };
}
