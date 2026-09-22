import { randomBytes } from "node:crypto";
import { deleteObject, presignUpload, type PresignedUpload } from "./r2";
import { LISTING_IMAGE_TYPES, MAX_UPLOAD_BYTES } from "./validate";

/**
 * The public half of storage: an owner's listing photos.
 *
 * Same shape as `claim-docs.ts`, different bucket and different rules. A photo
 * is meant to be seen, so it goes to the media bucket that the CDN serves, and
 * the object the browser uploads is the ORIGINAL — the derivatives worker
 * (worker/jobs/derivatives.ts) reads it back, sniffs the magic bytes, strips
 * the EXIF and writes the four WebP sizes beside it. Until that has happened
 * the `listing_images` row has no `derivatives`, and the public gallery does
 * not show it: the original is never served.
 *
 * Fails closed when the R2 credentials are absent, which is the local and
 * staging state today. The photos page says uploads are not available rather
 * than offering a button that throws.
 */

export const LISTING_PHOTO_MAX_BYTES = MAX_UPLOAD_BYTES;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exact shape `listingPhotoKey` mints, with the listing id fixed. */
const KEY_SUFFIX = /^photo-[0-9a-f]{16}\.(jpg|png|webp)$/;

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export function listingPhotosConfigured(): boolean {
  return !(
    blank(process.env.R2_ACCOUNT_ID) ||
    blank(process.env.R2_ACCESS_KEY_ID) ||
    blank(process.env.R2_SECRET_ACCESS_KEY) ||
    blank(process.env.R2_BUCKET_MEDIA)
  );
}

/** The media bucket name, or a refusal — never a URL signed against "undefined". */
export function listingPhotosEnv(): string {
  if (!listingPhotosConfigured()) {
    throw new Error("Listing photo storage is not configured (R2_BUCKET_MEDIA)");
  }
  return process.env.R2_BUCKET_MEDIA!.trim();
}

export function isAllowedListingPhotoType(contentType: string): boolean {
  return (LISTING_IMAGE_TYPES as readonly string[]).includes(contentType);
}

/**
 * The object key, chosen by the server, never from the uploaded filename.
 * `listings/<id>/` is the prefix the confirm step checks; the random suffix
 * means a re-upload cannot overwrite an earlier one, and the row — not the
 * bucket — says which keys are current.
 */
export function listingPhotoKey(listingId: string, contentType: string): string {
  if (!UUID.test(listingId)) throw new Error("listingPhotoKey: listing id must be a uuid");
  const ext = EXTENSIONS[contentType];
  if (ext === undefined) throw new Error(`listingPhotoKey: ${contentType} is not allowed here`);
  return `listings/${listingId.toLowerCase()}/photo-${randomBytes(8).toString("hex")}.${ext}`;
}

/**
 * Is this a key `listingPhotoKey` could have minted for this listing?
 *
 * The key goes out with the upload form and comes back with the confirm step,
 * so it is text the owner chose by the time it is stored. A prefix check is
 * not enough (`listings/<id>/../<other>/…` passes one), so the whole key has
 * to match the one shape the server produces, character for character. See
 * `isClaimDocKey` for the longer version of why.
 */
export function isListingPhotoKey(listingId: string, key: string): boolean {
  if (!UUID.test(listingId) || listingId !== listingId.toLowerCase()) return false;
  const prefix = `listings/${listingId}/`;
  return key.startsWith(prefix) && KEY_SUFFIX.test(key.slice(prefix.length));
}

/**
 * The exact content type is pinned in the policy rather than the `image/`
 * prefix `presignUpload` defaults to: `image/svg+xml` starts with `image/`,
 * and an SVG is a script. The worker still sniffs the bytes — a declared type
 * is a claim, not a fact — but R2 should refuse the obvious case at upload.
 */
// `async` so a refusal comes back as a rejected promise: every caller awaits
// this inside a try.
export async function presignListingPhotoUpload(
  key: string,
  contentType: string,
): Promise<PresignedUpload> {
  const bucket = listingPhotosEnv();
  if (!isAllowedListingPhotoType(contentType)) {
    throw new Error(`File type ${contentType} is not allowed here`);
  }
  return presignUpload(bucket, key, {
    contentTypePrefix: contentType,
    maxBytes: LISTING_PHOTO_MAX_BYTES,
  });
}

/** Removes an original or a derivative. Best-effort at the call site: the row is the truth. */
export function deleteListingPhotoObject(key: string): Promise<void> {
  return deleteObject(listingPhotosEnv(), key);
}
