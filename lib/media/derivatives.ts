import sharp from "sharp";

export const DERIVATIVE_SIZES = { thumb: 200, card: 600, hero: 1200, full: 2000 } as const;
export type DerivativeKey = keyof typeof DERIVATIVE_SIZES;

/**
 * Runs in the worker at upload time, never per request. Image optimisation on
 * the app server is CPU-bound and, across ten sites, the first thing to fall
 * over.
 *
 * `.rotate()` before resizing is not optional: sharp drops metadata by default
 * (which is what strips EXIF GPS from business photos), and stripping the
 * orientation tag without first applying it leaves every phone photo sideways.
 * `withoutEnlargement` keeps a small original small rather than blurring it up.
 */
export async function generateDerivatives(
  input: Buffer,
): Promise<Record<DerivativeKey, Buffer>> {
  const keys = Object.keys(DERIVATIVE_SIZES) as DerivativeKey[];
  const entries = await Promise.all(
    keys.map(async (key) => {
      const buf = await sharp(input)
        .rotate()
        .resize({ width: DERIVATIVE_SIZES[key], withoutEnlargement: true })
        .webp({ quality: key === "thumb" ? 70 : 82 })
        .toBuffer();
      return [key, buf] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<DerivativeKey, Buffer>;
}
