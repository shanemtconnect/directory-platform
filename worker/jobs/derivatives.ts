import { eq, isNull } from "drizzle-orm";
import { listingImages } from "@/lib/db/schema";
import { generateDerivatives, type DerivativeKey } from "@/lib/media/derivatives";
import { getObject, putObject } from "@/lib/media/r2";
import type { TestDb } from "@/test/db";

const BATCH = 20;

/**
 * Picks up originals with no derivatives yet, produces the four WebP sizes and
 * writes them back. Deliberately batched and idempotent: a row is only marked
 * done once every derivative is written, so a crash mid-batch just reprocesses.
 */
export async function processPendingDerivatives(db: TestDb): Promise<number> {
  const pending = await db
    .select({ id: listingImages.id, listingId: listingImages.listingId, storagePath: listingImages.storagePath })
    .from(listingImages)
    .where(isNull(listingImages.derivatives))
    .limit(BATCH);

  let done = 0;
  for (const image of pending) {
    try {
      const original = await getObject(process.env.R2_BUCKET_MEDIA!, image.storagePath);
      const derived = await generateDerivatives(original);
      const paths: Partial<Record<DerivativeKey, string>> = {};
      for (const [key, buf] of Object.entries(derived) as [DerivativeKey, Buffer][]) {
        const path = `${image.listingId}/${image.id}-${key}.webp`;
        await putObject(process.env.R2_BUCKET_MEDIA!, path, buf, "image/webp");
        paths[key] = path;
      }
      await db.update(listingImages).set({ derivatives: paths }).where(eq(listingImages.id, image.id));
      done++;
    } catch (e) {
      console.error(`[derivatives] ${image.id} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return done;
}
