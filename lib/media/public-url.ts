import { DERIVATIVE_SIZES, type DerivativeKey } from "./derivatives";
import type { PublicListingImage } from "@/lib/db/queries/listing-detail";

/**
 * Where a stored key is served from.
 *
 * Images live on the Cloudflare-proxied R2 domain, `NEXT_PUBLIC_MEDIA_URL`.
 * Without one there is nowhere to point an `<img>` at: a relative path would
 * resolve against the site's own origin, which does not serve the bucket, so
 * the answer is null and the gallery renders nothing rather than a broken
 * image. Build-optional (config/validate.ts), so this is checked per call
 * rather than at import.
 */
export function mediaUrl(path: string | null): string | null {
  const base = process.env.NEXT_PUBLIC_MEDIA_URL;
  if (!base || !path) return null;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** One image as the public gallery renders it: absolute URLs and fixed boxes. */
export interface GalleryImage {
  id: string;
  alt: string;
  hero: string;
  heroWidth: number;
  heroHeight: number;
  card: string;
  cardWidth: number;
  cardHeight: number;
  /** The largest derivative, for the JSON-LD `image` and a lightbox if one is ever added. */
  full: string;
}

/** The sizes the page needs from the worker's blob, or null when any is missing. */
function derivativePaths(value: unknown): Record<DerivativeKey, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const blob = value as Record<string, unknown>;
  const out: Partial<Record<DerivativeKey, string>> = {};
  for (const key of Object.keys(DERIVATIVE_SIZES) as DerivativeKey[]) {
    const path = blob[key];
    if (typeof path !== "string" || path === "") return null;
    out[key] = path;
  }
  return out as Record<DerivativeKey, string>;
}

/**
 * `width`/`height` on the row are the largest derivative's, written by the
 * worker after the EXIF rotation has been applied. `withoutEnlargement` in
 * the worker means a narrower original is served at its own width, so the
 * box here follows the same rule. With no stored size (an image processed
 * before the worker recorded one) a 4:3 box at the derivative width is
 * still better than no attributes: the page does not shift as it loads.
 */
function box(
  width: number | null,
  height: number | null,
  target: number,
): { width: number; height: number } {
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { width: target, height: Math.round((target * 3) / 4) };
  }
  const w = Math.min(width, target);
  return { width: w, height: Math.round((height * w) / width) };
}

/**
 * The images the public page shows, in the order the owner set, hero first.
 *
 * Only rows the worker has finished: a row without derivatives is an original
 * that has not been sniffed, rotated or stripped of its EXIF yet, and the
 * original is never served. The JSON-LD `image` is built from this same list,
 * so the markup cannot claim a photo the page did not render.
 */
export function galleryImages(
  images: readonly PublicListingImage[],
  fallbackAlt = "",
): GalleryImage[] {
  const sorted = [...images].sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder,
  );
  const out: GalleryImage[] = [];
  for (const image of sorted) {
    const paths = derivativePaths(image.derivatives);
    if (paths === null) continue;
    const hero = mediaUrl(paths.hero);
    const card = mediaUrl(paths.card);
    const full = mediaUrl(paths.full);
    if (hero === null || card === null || full === null) continue;
    const heroBox = box(image.width, image.height, DERIVATIVE_SIZES.hero);
    const cardBox = box(image.width, image.height, DERIVATIVE_SIZES.card);
    out.push({
      id: image.id,
      alt: image.alt?.trim() || fallbackAlt,
      hero,
      heroWidth: heroBox.width,
      heroHeight: heroBox.height,
      card,
      cardWidth: cardBox.width,
      cardHeight: cardBox.height,
      full,
    });
  }
  return out;
}
