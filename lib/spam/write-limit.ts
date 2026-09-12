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
 * Five an hour, like the enquiry form.
 *
 * A visitor who spots three wrong phone numbers in a row is doing us a favour,
 * so the budget has to leave room for it; what it stops is a script filing a
 * report against every listing in a town to bury the real ones.
 */
export const REPORT_RATE_LIMIT = { limit: 5, windowSeconds: 3600 } as const;

/**
 * Three an hour.
 *
 * Asking to be removed is something a person does once, and each one commits
 * us to a five-working-day answer — so the cheapest denial of service against
 * this site is a flood of removal requests nobody can action in time.
 */
export const REMOVAL_REQUEST_RATE_LIMIT = { limit: 3, windowSeconds: 3600 } as const;

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

/** The message a blocked visitor sees. Minutes, because seconds read as an error. */
export function retryMessage(result: RateLimitResult): string {
  return `Too many changes from this connection. Please try again in ${Math.ceil(result.retryAfterSeconds / 60)} minutes.`;
}

/**
 * Three an hour, checked after validation. (Reviews module, Task 22.)
 *
 * A person reviewing several businesses they used for the same job is real —
 * three is room for that and for a retry. It is deliberately tighter than the
 * enquiry budget because a review moves a public rating and an enquiry does
 * not, and because the address still has to be confirmed before anything is
 * published: the rate limit is the cheap gate, the verification link is the
 * real one.
 */
export const REVIEW_RATE_LIMIT = { limit: 3, windowSeconds: 3600 } as const;

/**
 * Twenty an hour for an owner answering reviews.
 *
 * Replying is a signed-in, owner-only action with one reply allowed per
 * review, so the ceiling exists to stop a loop, not a person: a business
 * catching up on a month of reviews in one sitting must not be cut off.
 */
export const REVIEW_REPLY_RATE_LIMIT = { limit: 20, windowSeconds: 3600 } as const;

/**
 * One an hour, on the "send me a new confirmation link" button.
 *
 * The button takes an expired token and mails a fresh link to the address that
 * token was issued to, so it is a way to make the site send mail — tight on
 * purpose. One is enough for the person who actually lost the email, and not
 * enough to use the button as a way to pester somebody else's inbox.
 */
export const REVIEW_RESEND_RATE_LIMIT = { limit: 1, windowSeconds: 3600 } as const;
