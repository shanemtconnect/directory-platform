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
 * Ten an hour, and deliberately not behind Turnstile.
 *
 * The add-listing URL import (lib/actions/import-listing.ts) writes nothing:
 * it fetches one page and hands the fields back to the person's own form, which
 * still has to pass Turnstile to submit. What it can be abused for is making us
 * fetch pages for someone, so the budget is sized for a person who tries their
 * site, their Facebook page and a typo — not for a crawler.
 */
export const IMPORT_URL_RATE_LIMIT = { limit: 10, windowSeconds: 3600 } as const;

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
 * us to an answer inside `REMOVAL_SLA_WORKING_DAYS` working days
 * (lib/trust/working-days.ts) — so the cheapest denial of service against
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

/**
 * Five an hour, in front of /forgot-password.
 *
 * This one is NOT covered by AUTH_RATE_LIMIT: the page posts to a server
 * action, which reaches Better Auth through `auth.api` rather than through
 * app/api/auth/[...all], so the counter on that route never sees it. Sized for
 * a person who mistypes their address once and asks again, because the abuse
 * it stops is not a break-in — every reply is identical whether the address
 * exists or not — but the mail it causes US to send to a third party. An
 * unlimited form here is a free emailer pointed at anyone's inbox, signed with
 * our domain.
 *
 * Resending a verification email needs no budget of its own: the button calls
 * /api/auth directly, so AUTH_RATE_LIMIT already counts it.
 */
export const FORGOT_PASSWORD_RATE_LIMIT = { limit: 5, windowSeconds: 3600 } as const;

/**
 * Three an hour per ADDRESS, alongside the per-connection budget above.
 *
 * The ip counter stops one client leaning on the form; it does nothing about
 * a botnet, or anyone rotating addresses, pointing the form at one victim's
 * inbox — and every request past the first mints another live reset token
 * for that account, because Better Auth does not revoke the previous one.
 * Keyed by a hash of the lowercased address so the Redis key is not personal
 * data. When this one is spent the reply is the same "sent" sentence and no
 * token is minted: a different answer would be the enumeration oracle.
 */
export const FORGOT_PASSWORD_EMAIL_RATE_LIMIT = { limit: 3, windowSeconds: 3600 } as const;

/**
 * 300 a minute per address, in front of /api/webhooks/paypal.
 *
 * Every POST there used to cost a verify call to PayPal's API before any
 * throttle, so anyone who could guess the URL could spend our PayPal quota —
 * and the verify endpoint's rate limit is the one that, once tripped, rejects
 * the genuine event behind the flood. PayPal delivers from a small set of
 * addresses and retries with backoff, so 300 a minute is far above anything a
 * real burst of renewals produces and far below what a loop can spend. The
 * check sits before the body is read and before verification: a blocked
 * delivery costs a header lookup and a Redis INCR, nothing else.
 */
export const PAYPAL_WEBHOOK_RATE_LIMIT = { limit: 300, windowSeconds: 60 } as const;

/**
 * Thirty a minute per address, on the review confirmation link — the landing
 * page and the POST behind its button share the bucket.
 *
 * The token is 32 bytes of CSPRNG, so guessing it is not realistic; what the
 * limit stops is a guess loop also being a free database query generator, and
 * it costs a real reviewer nothing — they open the page once and press one
 * button. Same shape as `/claim/outreach/[token]`.
 */
export const REVIEW_VERIFY_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;

/**
 * Thirty a minute per address, on the claim confirmation link, page and POST
 * together. The same reasoning as the review link, with a larger prize behind
 * it: a confirmed claim hands over a listing.
 */
export const CLAIM_VERIFY_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;

/**
 * Sixty a minute per address, on /api/internal/revalidate, after the bearer
 * has matched.
 *
 * The route is bearer-gated and 404s to everyone else, so the limit is not
 * what keeps strangers out. It bounds what a leaked or mishandled token can
 * cost: each request marks up to 100 pages stale, and a loop with the token
 * could otherwise turn the ISR cache into a render treadmill. The worker
 * sends one small batch per job, so sixty a minute is far above anything it
 * produces. Sits after the bearer check on purpose — a wrong token gets the
 * 404 without spending anything, so the throttle cannot become a second way
 * to confirm the route exists.
 */
export const INTERNAL_REVALIDATE_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/**
 * Ten an hour, on "where did you put the badge?".
 *
 * A signed-in, owner-only action — the session and the ownership check are
 * the real gates — so the budget exists to stop a loop, not a person. Ten is
 * room for an owner to correct a typo, move the badge to a different page and
 * press "check now" a few times in one sitting; what it stops is a script
 * making the hourly worker fetch the same site over and over, or filling
 * `audit_log` with one row per second.
 */
export const BADGE_BACKLINK_RATE_LIMIT = { limit: 10, windowSeconds: 3600 } as const;

/**
 * Three an hour, checked after validation. (Quotes module, Task 47.)
 *
 * One request already reaches up to `siteConfig.quotes.maxRecipients`
 * inboxes, so this is the tightest of the public forms: a person asking for
 * two different jobs in one sitting is real, and three is room for a retry;
 * a script filling it in is a way to make the site send fifteen emails a
 * minute signed with our domain. Sits after field validation, as the others
 * do — a typo must not cost one of the three.
 */
export const QUOTE_RATE_LIMIT = { limit: 3, windowSeconds: 3600 } as const;

/**
 * Thirty a minute per address, on the unsubscribe link — the page and the
 * POST behind its button share the bucket. The token is an HMAC over the
 * address, so guessing it is not realistic; what the limit stops is a guess
 * loop being a free database write per guess. Same shape as the claim link.
 */
export const UNSUBSCRIBE_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;


/* ------------------------------------------------------ sponsor rails (Task 43) */
/** `/out/<id>` — a click is one GET; 30 a minute from one address is a script, not a reader. */
export const SPONSOR_CLICK_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;
/** The self-serve sponsor form: a campaign is a considered thing, not a burst. */
export const SPONSOR_SUBMIT_RATE_LIMIT = { limit: 5, windowSeconds: 3600 } as const;


/**
 * Three a day, checked after validation. (Jobs board, Task 49.)
 *
 * A business posting vacancies posts one, occasionally two; three in a day is
 * the edge of normal and nothing like enough for a spam run. Sized as a DAY
 * rather than an hour because the cost of each post is ours as much as the
 * poster's — every one is a human decision in the admin queue, and a paid
 * post is a PayPal order created on our account — so the budget is on what
 * one connection can make us do, not on what it can type.
 */
export const JOB_POST_RATE_LIMIT = { limit: 3, windowSeconds: 86_400 } as const;

/**
 * Sixty an hour on the Apply counter. It is a fire-and-forget increment
 * behind a link the visitor is following anyway; the cap stops one client
 * inflating a poster's numbers, and costs a real applicant nothing.
 */
export const JOB_APPLY_RATE_LIMIT = { limit: 60, windowSeconds: 3600 } as const;
