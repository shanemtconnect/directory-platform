import { and, eq, isNull, lt } from "drizzle-orm";
import sharp from "sharp";
import { listingImages } from "@/lib/db/schema";
import { resolveListingPaths } from "@/lib/db/queries/paths";
import { generateDerivatives, type DerivativeKey } from "@/lib/media/derivatives";
import { assertUploadable, LISTING_IMAGE_TYPES } from "@/lib/media/validate";
import { getObject, putObject, deleteObject } from "@/lib/media/r2";
import type { Db } from "@/lib/db/client";

const BATCH = 20;

/**
 * After this many failures the row is left alone. The job runs every minute
 * against every row with no derivatives, so without a cap one image that
 * cannot be processed costs an R2 GET and a sharp decode every minute for
 * ever, and the error scrolls past in the log unnoticed.
 */
export const MAX_DERIVATIVE_ATTEMPTS = 5;

/** Thrown for bytes that will never become an image, however many times we try. */
class UnprocessableUpload extends Error {}

/**
 * Picks up originals with no derivatives yet, produces the four WebP sizes and
 * writes them back. Deliberately batched and idempotent: a row is only marked
 * done once every derivative is written, so a crash mid-batch just reprocesses.
 */
export async function processPendingDerivatives(
  db: Db,
  /** Filled with the listing id of every image that went live, for the caller to revalidate. */
  liveListingIds?: Set<string>,
): Promise<number> {
  const pending = await db
    .select({
      id: listingImages.id,
      listingId: listingImages.listingId,
      storagePath: listingImages.storagePath,
      attempts: listingImages.derivativesAttempts,
    })
    .from(listingImages)
    .where(and(
      isNull(listingImages.derivatives),
      lt(listingImages.derivativesAttempts, MAX_DERIVATIVE_ATTEMPTS),
    ))
    .limit(BATCH);

  const bucket = process.env.R2_BUCKET_MEDIA!;
  let done = 0;
  for (const image of pending) {
    try {
      const original = await getObject(bucket, image.storagePath);

      // The object store is not a trusted source. The upload policy constrains
      // the Content-Type the browser DECLARES; only the magic bytes say what
      // the file IS, and sharp will rasterise an SVG quite happily.
      try {
        assertUploadable(original, { allow: LISTING_IMAGE_TYPES });
      } catch (e) {
        throw new UnprocessableUpload(e instanceof Error ? e.message : String(e));
      }

      const derived = await generateDerivatives(original);
      const paths: Partial<Record<DerivativeKey, string>> = {};
      for (const [key, buf] of Object.entries(derived) as [DerivativeKey, Buffer][]) {
        const path = `${image.listingId}/${image.id}-${key}.webp`;
        await putObject(bucket, path, buf, "image/webp");
        paths[key] = path;
      }
      // The size of the largest derivative, after `.rotate()` has applied the
      // EXIF orientation: what the public <img> needs for its width/height.
      const { width, height } = await sharp(derived.full).metadata();
      await db
        .update(listingImages)
        .set({
          derivatives: paths,
          derivativesError: null,
          width: width ?? null,
          height: height ?? null,
        })
        .where(eq(listingImages.id, image.id));
      liveListingIds?.add(image.listingId);
      done++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const permanent = e instanceof UnprocessableUpload;
      console.error(`[derivatives] ${image.id} failed:`, message);

      // A rejected file is not left sitting in the bucket where a signed URL
      // could still reach it, and it is never retried: the bytes will not
      // improve.
      if (permanent) await deleteObject(bucket, image.storagePath).catch(() => {});

      await db
        .update(listingImages)
        .set({
          derivativesAttempts: permanent ? MAX_DERIVATIVE_ATTEMPTS : image.attempts + 1,
          derivativesError: message,
        })
        .where(eq(listingImages.id, image.id));
    }
  }
  return done;
}

/**
 * The scheduled entry point. A photo that has just gone live is invisible on
 * the ISR-cached listing page until the window turns over, so the job hands
 * back the paths of every listing it finished an image for; worker/index.ts
 * sends them to the web container once this transaction has committed.
 */
export async function derivativesJob(db: Db): Promise<{ revalidate: string[] }> {
  const live = new Set<string>();
  await processPendingDerivatives(db, live);
  const revalidate: string[] = [];
  for (const listingId of live) revalidate.push(...(await resolveListingPaths(db, listingId)));
  return { revalidate };
}
