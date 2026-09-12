import { siteConfig } from "@/config/site.config";
import { isUuid, normaliseBody, stripCrlf } from "@/lib/actions/validation";

/**
 * Field validation for the public review form.
 *
 * Same shape and the same two rules as `lib/actions/validation.ts` — shape-check
 * anything compared against a uuid column, and strip CR/LF from every
 * single-line field — reusing that module's helpers rather than restating them.
 * It lives here rather than there because the review module owns it, and
 * because a "use server" module may only export async functions, so validation
 * that lives beside the action cannot be unit tested.
 *
 * The sub-ratings are the one thing this does that the other forms do not: the
 * criteria are `siteConfig.reviewCriteria`, so the fields exist on one clone
 * and not on the next, and a posted key that is not a configured criterion is
 * dropped rather than stored.
 */

export const REVIEW_MAX = {
  title: 120,
  body: 2000,
  displayName: 80,
  email: 254,
} as const;

/** Exactly one spelling of a rating is a rating: "4", not "4.0", " 4" or "1e0". */
const RATING = /^[1-5]$/;

/** The form field name carrying the sub-rating for a criterion. */
export function subRatingField(key: string): string {
  return `sub_${key}`;
}

export interface ReviewValues {
  listingId: string;
  rating: number;
  /** Null when the visitor answered none of them, so the column stays null. */
  subRatings: Record<string, number> | null;
  title: string | null;
  body: string;
  displayName: string;
  /** Lowercased: the one-review-per-listing index is on the exact string. */
  email: string;
}

type Result<T> =
  | { values: T; errors?: undefined }
  | { values?: undefined; errors: Record<string, string> };

function field(form: FormData, key: string): string {
  return stripCrlf(String(form.get(key) ?? "")).trim();
}

export function validateReview(form: FormData): Result<ReviewValues> {
  const errors: Record<string, string> = {};

  const listingId = field(form, "listingId");
  const rating = field(form, "rating");
  const title = field(form, "title");
  const body = normaliseBody(String(form.get("body") ?? "")).trim();
  const displayName = field(form, "displayName");
  const email = field(form, "email").toLowerCase();

  // A hidden field, so this is never a typo — it is a tampered form or a bot.
  if (!isUuid(listingId)) errors.listingId = "That listing could not be found.";
  if (!RATING.test(rating)) errors.rating = "Please choose a rating from 1 to 5.";

  const subRatings: Record<string, number> = {};
  for (const criterion of siteConfig.reviewCriteria) {
    const raw = field(form, subRatingField(criterion.key));
    // Optional: a visitor who rates the whole thing and skips the breakdown
    // has still written a review.
    if (raw === "") continue;
    if (!RATING.test(raw)) {
      errors[subRatingField(criterion.key)] = "Please choose a rating from 1 to 5.";
      continue;
    }
    subRatings[criterion.key] = Number(raw);
  }

  if (title.length > REVIEW_MAX.title) errors.title = "That title is too long.";

  if (body.length === 0) {
    errors.body = "Please tell people what happened.";
  } else if (body.length > REVIEW_MAX.body) {
    errors.body = `Please keep it under ${REVIEW_MAX.body} characters.`;
  }

  if (displayName.length < 2) errors.displayName = "Please give a name to publish this under.";
  if (displayName.length > REVIEW_MAX.displayName) errors.displayName = "That name is too long.";

  // Deliberately permissive, as on the enquiry form: the address is proved by
  // whether the verification link is clicked, not by a regex.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    errors.email = "Please give a valid email address.";
  }
  if (email.length > REVIEW_MAX.email) errors.email = "That email address is too long.";

  if (Object.keys(errors).length > 0) return { errors };

  return {
    values: {
      listingId,
      rating: Number(rating),
      subRatings: Object.keys(subRatings).length > 0 ? subRatings : null,
      title: title === "" ? null : title,
      body,
      displayName,
      email,
    },
  };
}
