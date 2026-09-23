"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import {
  createOwnerPhoto,
  deleteOwnerPhoto,
  ownerPhotoQuota,
  reorderOwnerPhotos,
  setOwnerPhotoAlt,
} from "@/lib/db/queries/photos";
import {
  deleteListingPhotoObject,
  isAllowedListingPhotoType,
  isListingPhotoKey,
  listingPhotoKey,
  listingPhotosConfigured,
  presignListingPhotoUpload,
} from "@/lib/media/listing-photos";
import { LISTING_PHOTO_ALT_MAX } from "@/lib/media/validate";
import { revalidateListingPaths } from "@/lib/revalidate/listing";
import { clientIp } from "@/lib/spam/client-ip";
import type { Db } from "@/lib/db/client";

/**
 * The owner's photo mutations.
 *
 * Same shape as the claim-document upload: the action signs a POST policy,
 * the browser sends the bytes straight to the media bucket, and a second
 * action records where they landed. The file never touches the app server.
 *
 * None of these take an owner id. Scoping is inside the queries, which
 * resolve the viewer's own profile; a tampered listing or photo id matches
 * nothing. Every one reads the request address for the audit row.
 */

export type PhotoActionResult = { ok: true } | { ok: false; message: string };

export type PreparePhotoResult =
  | { ok: true; key: string; url: string; fields: Record<string, string> }
  | { ok: false; message: string };

const SIGN_IN = "Please sign in.";
const NOT_FOUND = "That listing could not be found.";
const GENERIC = "Something went wrong. Please try again.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function capMessage(max: number): string {
  return `This plan allows ${max} ${max === 1 ? "photo" : "photos"}. Delete one to add another, or upgrade for more.`;
}

function photosPage(listingId: string): string {
  return `/account/listings/${listingId}/photos`;
}

function bust(paths: readonly string[], listingId: string): void {
  revalidateListingPaths(paths);
  revalidatePath(photosPage(listingId));
}

/**
 * Checks the cap and signs the upload. The cap is checked again on confirm,
 * inside the transaction; this is the early answer so nobody spends a minute
 * uploading a file the site will then refuse.
 */
export async function preparePhotoUpload(input: {
  listingId: string;
  contentType: string;
}): Promise<PreparePhotoResult> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { ok: false, message: SIGN_IN };

  // The page hides the form when storage is unconfigured; this is the server
  // side of the same statement, because a hidden control is not a check.
  if (!listingPhotosConfigured()) {
    return { ok: false, message: "Photo uploads are not available on this site yet." };
  }
  if (!isAllowedListingPhotoType(input.contentType)) {
    return { ok: false, message: "Please upload a JPEG, PNG or WebP image." };
  }
  if (!UUID.test(input.listingId)) return { ok: false, message: NOT_FOUND };

  const quota = await ownerPhotoQuota(db, viewer, input.listingId);
  if (quota === null) return { ok: false, message: NOT_FOUND };
  if (quota.max !== null && quota.used >= quota.max) {
    return { ok: false, message: capMessage(quota.max) };
  }

  const key = listingPhotoKey(input.listingId.toLowerCase(), input.contentType);
  try {
    const signed = await presignListingPhotoUpload(key, input.contentType);
    return { ok: true, key, url: signed.url, fields: signed.fields };
  } catch {
    // Never the underlying message: it names the bucket and the account.
    return { ok: false, message: "We could not start the upload. Please try again." };
  }
}

/** Records where the photo landed, once the browser's POST to R2 succeeded. */
export async function confirmPhotoUpload(input: {
  listingId: string;
  key: string;
}): Promise<PhotoActionResult> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { ok: false, message: SIGN_IN };

  // The key travels through the browser, so it is checked rather than
  // trusted, and before the transaction opens: the whole key has to be one
  // the server could have minted for THIS listing.
  const listingId = input.listingId.toLowerCase();
  if (!isListingPhotoKey(listingId, input.key)) return { ok: false, message: GENERIC };

  const ip = clientIp(await headers());
  const result = await db.transaction(async (tx) =>
    createOwnerPhoto(tx as unknown as Db, viewer, { listingId, storagePath: input.key, ip }),
  );

  switch (result.outcome) {
    case "created":
      bust(result.paths, listingId);
      return { ok: true };
    case "limit":
      return { ok: false, message: capMessage(result.max) };
    case "not-found":
      return { ok: false, message: NOT_FOUND };
    case "bad-key":
      return { ok: false, message: GENERIC };
  }
}

/**
 * The row goes first, inside the transaction; the objects go after it has
 * returned, best-effort. An object deleted before a rollback is gone for
 * good, while an orphan in the bucket is a few kilobytes nobody can reach.
 *
 * No listing id is taken: the photo's row says which listing it belongs to,
 * and that is what the owner's page is revalidated for.
 */
export async function deletePhoto(input: { photoId: string }): Promise<PhotoActionResult> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { ok: false, message: SIGN_IN };

  const ip = clientIp(await headers());
  const result = await db.transaction(async (tx) =>
    deleteOwnerPhoto(tx as unknown as Db, viewer, input.photoId, ip),
  );
  if (result.outcome === "not-found") return { ok: false, message: "That photo could not be found." };

  // Best-effort and never fatal: the row is gone and audited. Unconfigured
  // storage (staging) rejects here rather than throwing, so the catch holds.
  for (const key of result.keys) {
    await deleteListingPhotoObject(key).catch(() => {});
  }
  bust(result.paths, result.listingId);
  return { ok: true };
}

export async function reorderPhotos(input: {
  listingId: string;
  orderedIds: string[];
}): Promise<PhotoActionResult> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { ok: false, message: SIGN_IN };

  const listingId = input.listingId.toLowerCase();
  const ip = clientIp(await headers());
  const result = await db.transaction(async (tx) =>
    reorderOwnerPhotos(tx as unknown as Db, viewer, listingId, input.orderedIds, ip),
  );

  switch (result.outcome) {
    case "saved":
      bust(result.paths, listingId);
      return { ok: true };
    case "mismatch":
      return { ok: false, message: "The photos changed while this page was open. Reload and try again." };
    case "not-found":
      return { ok: false, message: NOT_FOUND };
  }
}

export async function savePhotoAlt(input: {
  photoId: string;
  alt: string;
}): Promise<PhotoActionResult> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { ok: false, message: SIGN_IN };

  const alt = input.alt.replace(/[\r\n]+/g, " ").trim();
  if (alt.length > LISTING_PHOTO_ALT_MAX) {
    return {
      ok: false,
      message: `Please keep the description under ${LISTING_PHOTO_ALT_MAX} characters.`,
    };
  }

  const ip = clientIp(await headers());
  const result = await db.transaction(async (tx) =>
    setOwnerPhotoAlt(tx as unknown as Db, viewer, input.photoId, alt, ip),
  );
  if (result.outcome === "not-found") return { ok: false, message: "That photo could not be found." };

  bust(result.paths, result.listingId);
  return { ok: true };
}
