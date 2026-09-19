/**
 * Whether a verified review publishes itself or waits for a person.
 *
 * The decision is made HERE, in a pure function, because it is the only part
 * of the review pipeline that is a judgement call and therefore the only part
 * worth arguing with in a test. Everything else — the token, the aggregate,
 * the unique index — is mechanical.
 *
 * Two things this deliberately is not:
 *
 *  - It is not a rating filter. A one-star review that reads like a real
 *    experience publishes exactly as fast as a five-star one. A directory that
 *    quietly holds bad reviews for review is running a ratings shop, and the
 *    whole value of the module is that it does not.
 *  - It is not a spam classifier. It catches the four shapes that account for
 *    almost all of what an open review form collects — the advert, the contact
 *    detail, the abuse and the empty "great!" — and hands everything else to a
 *    human queue rather than guessing.
 *
 * Nothing in here is niche-specific: a review of a plumber and a review of a
 * restaurant are flagged by the same rules.
 */

/** In the order they are checked, which is the order they are reported in. */
export const FLAG_REASONS = [
  "too-short",
  "contact-details",
  "link",
  "profanity",
  "shouting",
] as const;

export type FlagReason = (typeof FLAG_REASONS)[number];

/**
 * Below this a review says nothing a reader could act on.
 *
 * It is a HOLD, not a rejection: the form accepts shorter text and a moderator
 * can publish it. What it stops is a wall of "Great!" arriving unattended and
 * moving a listing's average.
 */
export const MIN_BODY_CHARS = 40;

/**
 * Hosts are matched against a TLD list rather than `\.[a-z]{2,}` because the
 * open-ended version reads the end of any unspaced sentence — "again.No
 * complaints" — as a Norwegian domain, and a false hold is a real review a
 * moderator has to rescue by hand.
 */
const TLDS = [
  "co\\.uk", "org\\.uk", "com", "net", "org", "io", "dev", "app", "shop",
  "store", "online", "site", "xyz", "info", "biz", "uk", "ie", "de", "fr",
  "es", "it", "nl", "us", "ca", "au", "nz", "eu",
].join("|");

const LINK = new RegExp(`https?://|\\bwww\\.|\\b[a-z0-9][a-z0-9-]*\\.(?:${TLDS})\\b`, "i");

const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

/**
 * Word boundaries on every entry, so "assessment" is not profanity and
 * "Scunthorpe" is still a place. The list is short on purpose: it exists to
 * route abuse to a moderator, not to police vocabulary.
 */
const PROFANITY = [
  "shit", "shite", "fuck", "fucked", "fucking", "cunt", "bastard", "bollocks",
  "wanker", "arsehole", "asshole", "bitch", "prick", "twat", "dickhead",
  "motherfucker", "piss", "slag", "whore",
];

const PROFANITY_RE = new RegExp(`\\b(?:${PROFANITY.join("|")})\\b`, "i");

/**
 * A phone number survives any amount of spacing, so the separators BETWEEN
 * digits are collapsed before the run is measured. Only between digits: doing
 * it unconditionally would join "we paid 2400" and "in March 2026" into an
 * eleven-digit number that was never written.
 */
const DIGIT_SEPARATORS = /(?<=\d)[\s().–—-]+(?=\d)/g;
const PHONE_RUN = /\d{7,}/;

/** At least this many letters before a capitals ratio means anything. */
const SHOUT_MIN_LETTERS = 20;
const SHOUT_RATIO = 0.8;

export interface ReviewTextInput {
  title?: string | null;
  body?: string | null;
  displayName?: string | null;
}

function isShouting(body: string): boolean {
  const letters = body.replace(/[^A-Za-z]/g, "");
  if (letters.length < SHOUT_MIN_LETTERS) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= SHOUT_RATIO;
}

/**
 * Returns the reason to hold this review, or null to publish it.
 *
 * The title and the display name are read alongside the body: a name field is
 * a perfectly good place to put a URL, and several review-spam runs use
 * nothing else.
 */
export function flagReview(input: ReviewTextInput): FlagReason | null {
  const body = (input.body ?? "").trim();
  if (body.length < MIN_BODY_CHARS) return "too-short";

  const all = [input.title ?? "", body, input.displayName ?? ""].join("\n");

  if (EMAIL.test(all)) return "contact-details";
  if (PHONE_RUN.test(all.replace(DIGIT_SEPARATORS, ""))) return "contact-details";
  if (LINK.test(all)) return "link";
  if (PROFANITY_RE.test(all)) return "profanity";
  if (isShouting(body)) return "shouting";

  return null;
}
