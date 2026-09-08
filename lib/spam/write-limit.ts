import { clientIp, rateLimitSubject } from "@/lib/spam/client-ip";
import { rateLimit, type RateLimitResult } from "@/lib/spam/rate-limit";

/**
 * One rate limit for one public write path, from the request's own headers.
 *
 * Every write anyone on the internet can reach goes through a counter — the
 * enquiry form, the submission form, and the shortlist. The shortlist actions
 * were the gap: only `addToShortlist` counted anything, and it read
 * `x-forwarded-for` itself, taking the FIRST hop (which the client writes, so
 * an attacker just varies it) and bucketing everything with no proxy header
 * together under the string "unknown" (so one bot locks out every other
 * unidentified visitor). `clientIp`/`rateLimitSubject` are the shared answer to
 * both, and this is the one call that puts them in front of an action.
 *
 * `feature` is the bucket name. Every mutation of the same feature shares one
 * bucket on purpose: a budget spent per action would let a client multiply it
 * by rotating between add, remove, rename and share.
 */
export async function limitPublicWrite(
  feature: string,
  requestHeaders: Headers,
  opts: { limit: number; windowSeconds: number },
): Promise<RateLimitResult> {
  const subject = rateLimitSubject(clientIp(requestHeaders));
  return rateLimit(subject && `${feature}:${subject}`, opts);
}

/**
 * Deliberately generous, and deliberately not behind Turnstile.
 *
 * Saving is a one-click action a real visitor does repeatedly while comparing —
 * add, remove, re-add, rename, share — so a tight cap or a challenge would
 * break the feature for the people using it properly. What it stops is the
 * cheap version of the abuse: one client minting endless cookies to create
 * endless lists, or hammering a rename to fill the table with text.
 */
export const SHORTLIST_RATE_LIMIT = { limit: 120, windowSeconds: 3600 } as const;

/** The message a blocked visitor sees. Minutes, because seconds read as an error. */
export function retryMessage(result: RateLimitResult): string {
  return `Too many changes from this connection. Please try again in ${Math.ceil(result.retryAfterSeconds / 60)} minutes.`;
}
