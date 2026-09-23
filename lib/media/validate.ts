export type SniffedMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** What an alt attribute can usefully hold; longer is a caption, not alt text. */
export const LISTING_PHOTO_ALT_MAX = 250;
export const LISTING_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const CLAIM_DOCUMENT_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;

const SIGNATURES: readonly { mime: SniffedMime; bytes: readonly (number | null)[] }[] = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  // RIFF....WEBP — bytes 4-7 are the length, so they are wildcards.
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
];

/**
 * Magic bytes only. Never trust a filename extension or a client-supplied
 * Content-Type — an SVG renamed to .jpg is a stored-XSS vector, and extension
 * checking is exactly what lets it through.
 */
export function sniffMime(buf: Buffer): SniffedMime | null {
  for (const sig of SIGNATURES) {
    if (buf.byteLength < sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => b === null || buf[i] === b)) return sig.mime;
  }
  return null;
}

export function assertUploadable(
  buf: Buffer,
  opts: { allow: readonly string[]; maxBytes?: number },
): SniffedMime {
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  if (buf.byteLength > maxBytes) {
    throw new Error(`File too large: ${buf.byteLength} bytes exceeds the ${maxBytes} byte limit`);
  }
  const mime = sniffMime(buf);
  if (mime === null) throw new Error("Unrecognised file type — upload rejected");
  if (!opts.allow.includes(mime)) throw new Error(`File type ${mime} is not allowed here`);
  return mime;
}
