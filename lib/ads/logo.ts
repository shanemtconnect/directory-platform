import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { assertUploadable, LISTING_IMAGE_TYPES } from "@/lib/media/validate";
import { putObject } from "@/lib/media/r2";
import { isUuid } from "@/lib/stats/keys";

/**
 * A sponsor's logo: validated by magic bytes, EXIF stripped, squared to
 * `LOGO_SIZE` and stored as WebP under the public media bucket (constraint 15).
 * When `R2_*` is unset the campaign simply has no logo and the card shows
 * the advertiser's initial — never a runtime failure.
 */
export const LOGO_SIZE = 256;
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export function sponsorLogosConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !(
    blank(env.R2_ACCOUNT_ID) ||
    blank(env.R2_ACCESS_KEY_ID) ||
    blank(env.R2_SECRET_ACCESS_KEY) ||
    blank(env.R2_BUCKET_MEDIA)
  );
}

export function sponsorLogoKey(campaignId: string): string {
  if (!isUuid(campaignId)) throw new Error("sponsorLogoKey: campaign id must be a uuid");
  return `sponsors/${campaignId.toLowerCase()}/logo-${randomBytes(8).toString("hex")}.webp`;
}

/** Validate, strip, square and convert. Throws on anything that is not a small image. */
export async function processSponsorLogo(input: Buffer): Promise<Buffer> {
  assertUploadable(input, { allow: LISTING_IMAGE_TYPES, maxBytes: LOGO_MAX_BYTES });
  return sharp(input)
    .rotate()
    .resize(LOGO_SIZE, LOGO_SIZE, { fit: "cover", withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
}

/** Returns the stored key, or null when storage is not configured. */
export async function storeSponsorLogo(
  campaignId: string,
  processed: Buffer,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  if (!sponsorLogosConfigured(env)) return null;
  const key = sponsorLogoKey(campaignId);
  await putObject(env.R2_BUCKET_MEDIA!.trim(), key, processed, "image/webp");
  return key;
}

/** The public URL for a stored logo, or null when there is no media origin to serve it from. */
export function sponsorLogoUrl(
  path: string | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const base = env.NEXT_PUBLIC_MEDIA_URL;
  if (!base || !path) return null;
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export { sponsorInitial } from "./initial";
