import { randomBytes } from "node:crypto";
import { now } from "@/lib/clock";

/**
 * The magic link that turns a domain-email match into an approved claim.
 *
 * Short-lived on purpose. The token is the whole of the proof — whoever holds
 * it owns the listing — and it travels through a mailbox, gets forwarded, and
 * ends up in search indexes when somebody pastes it somewhere. Thirty minutes
 * is long enough to walk to a laptop and no longer.
 */

export const MAGIC_TOKEN_TTL_MINUTES = 30;

/**
 * 256 bits from the CSPRNG, base64url so it survives a URL path segment
 * untouched. `Math.random` is not an option: a guessable token is a listing
 * handed to whoever guesses it.
 */
export function newMagicToken(): string {
  return randomBytes(32).toString("base64url");
}

export function magicTokenExpiry(): Date {
  return new Date(now().getTime() + MAGIC_TOKEN_TTL_MINUTES * 60_000);
}

/** A claim with no expiry recorded has no live token, so it is never valid. */
export function isTokenExpired(expiresAt: Date | null): boolean {
  if (expiresAt === null) return true;
  return expiresAt.getTime() < now().getTime();
}
