import { randomBytes, randomInt } from "node:crypto";
import { slugify } from "@/lib/routing/slugify";

/**
 * The magic link's token.
 *
 * It is a bearer credential, not an identifier: whoever holds it lands on the
 * claim flow for that listing. 32 bytes from the CSPRNG, base64url so it
 * survives a URL, an email client and a copy-paste.
 */
export function magicToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * No 0/O, 1/I/L. A coupon code is read off a printed letter or repeated down
 * a phone; an ambiguous character is a discount the recipient does not get and
 * a support email we do.
 */
export const COUPON_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const SUFFIX_LENGTH = 6;

/**
 * `SAVE50-7KQP4M`. The suffix is ~31^6 ≈ 8.9e8, and the `coupons.code` unique
 * index is the real guarantee — the generator retries on collision.
 */
export function couponCode(prefix: string): string {
  let suffix = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    suffix += COUPON_ALPHABET[randomInt(COUPON_ALPHABET.length)];
  }
  return `${slugify(prefix).toUpperCase()}-${suffix}`;
}
