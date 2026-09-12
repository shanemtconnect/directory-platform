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

/*
 * Every public write budget lives below, together.
 *
 * They were scattered — two as inline literals at their call sites, two as
 * named constants in different files — and a budget only means anything
 * relative to the others. Side by side you can see the shape: one-off forms
 * are tight, repeated actions are generous, and auth gets a short window
 * because credential stuffing arrives in a burst rather than a trickle.
 * Each site still owns its own subject prefix and its own wording.
 */

/**
 * Five an hour, checked after validation.
 *
 * A visitor enquiring with several listings on a shortlist is doing something
 * normal; a person sending five in an hour to the same site is not far off the
 * ceiling of normal. The counter sits after field validation on purpose — a
 * postcode typo should not cost one of the five.
 */
export const ENQUIRY_RATE_LIMIT = { limit: 5, windowSeconds: 3600 } as const;

/**
 * Three an hour.
 *
 * A person listing their own business does it once. Three is room for a
 * genuine retry and nothing like enough for a spam run.
 */
export const SUBMIT_LISTING_RATE_LIMIT = { limit: 3, windowSeconds: 3600 } as const;

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

/**
 * 20 POSTs per 10 minutes per client, in front of `/api/auth/[...all]`.
 *
 * Everything a stranger can POST there is an attempt at somebody's account —
 * sign-in, sign-up, forgot-password, reset-password — so the budget is sized
 * for a person who mistypes a password and asks for a reset, not for a script
 * working through a credential list.
 *
 * One bucket for every auth POST on purpose: a budget spent per endpoint would
 * let a client multiply it by rotating between sign-in, sign-up and
 * forgot-password, which is exactly what credential stuffing does.
 *
 * This sits IN FRONT OF Better Auth's own limiter rather than replacing it.
 * Better Auth's is in-memory and therefore per instance (lib/auth/server.ts),
 * so behind several replicas it lets through a multiple of its cap; this one
 * counts in Redis, shared across replicas, and falls back to a per-process map
 * only while Redis is down.
 */
export const AUTH_RATE_LIMIT = { limit: 20, windowSeconds: 600 } as const;

/**
 * 120 beacons per 10 minutes per client.
 *
 * Not a write budget in the sense the others are — nothing here reaches the
 * database — but the same shape of problem: a public endpoint anyone can POST
 * to, whose counters are the number a listing owner is later asked to renew
 * against. Sized for a person browsing hard: one beacon per page view, so 120
 * is a page every five seconds for ten minutes.
 *
 * Generous on purpose at the individual level, because the cost of a false
 * positive is a silently uncounted view. What it stops is the cheap version of
 * the abuse: one client looping the endpoint to inflate their own numbers.
 */
export const BEACON_RATE_LIMIT = { limit: 120, windowSeconds: 600 } as const;

/** The message a blocked visitor sees. Minutes, because seconds read as an error. */
export function retryMessage(result: RateLimitResult): string {
  return `Too many changes from this connection. Please try again in ${Math.ceil(result.retryAfterSeconds / 60)} minutes.`;
}
