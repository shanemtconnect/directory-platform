import { createHmac, timingSafeEqual } from "node:crypto";
import { siteUrl } from "@/lib/schema/builders";

/**
 * The opt-out link's token.
 *
 * Every marketing-flavoured email we send to an address nobody gave us for
 * that purpose — a quote request to an unclaimed listing's scraped address —
 * carries a link that unsubscribes that address with one click and no
 * sign-in. The link has to identify the address without letting anyone
 * unsubscribe somebody else, so it carries the address and the listing it
 * was sent about, signed with a key only the server holds. Nothing is
 * stored: the token IS the proof, verified by recomputing the signature.
 *
 * `EMAIL_UNSUBSCRIBE_SECRET` is the key; `BETTER_AUTH_SECRET` is the
 * fallback so a deploy that has not set one still produces working links
 * rather than none. With neither set no token is minted and the email goes
 * out without the link — the worker never sends a link that cannot work.
 */

export interface ListingUnsubscribeClaim {
  /** The address as it was written to, not normalised — the page shows it back. */
  email: string;
  listingId: string;
}

/**
 * A saved search's digest (Task 54). The link turns that one search's
 * alerts off (`saved_searches.is_active = false`); it does not put the
 * address on the `unsubscribes` list, which is about unsolicited mail.
 */
export interface SavedSearchUnsubscribeClaim {
  savedSearchId: string;
  /** The address the digest went to — the page shows it back. */
  email: string;
}

export type UnsubscribeClaim = ListingUnsubscribeClaim | SavedSearchUnsubscribeClaim;

export const isSavedSearchClaim = (claim: UnsubscribeClaim): claim is SavedSearchUnsubscribeClaim =>
  "savedSearchId" in claim;

function secret(): string | null {
  const s = process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim() || "";
  return s === "" ? null : s;
}

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
const unb64 = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

/** `<payload>.<signature>`, or null when no key is configured. */
export function signUnsubscribe(claim: UnsubscribeClaim): string | null {
  const key = secret();
  if (key === null) return null;
  // `l` for a listing, `s` for a saved search: the key IS the variant, so a
  // token minted for one can never be read as the other.
  const body = isSavedSearchClaim(claim)
    ? { e: claim.email, s: claim.savedSearchId }
    : { e: claim.email, l: claim.listingId };
  const payload = b64(JSON.stringify(body));
  return `${payload}.${sign(payload, key)}`;
}

/** The claim a token carries, or null for anything that is not ours, byte for byte. */
export function verifyUnsubscribe(token: string | null | undefined): UnsubscribeClaim | null {
  const key = secret();
  if (key === null || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload, key), "utf8");
  // Length first: timingSafeEqual throws on unequal lengths, and a length
  // mismatch is not a secret worth hiding.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const parsed = JSON.parse(unb64(payload)) as { e?: unknown; l?: unknown; s?: unknown };
    const filled = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
    if (!filled(parsed.e)) return null;
    if (filled(parsed.l) && parsed.s === undefined) return { email: parsed.e, listingId: parsed.l };
    if (filled(parsed.s) && parsed.l === undefined) return { savedSearchId: parsed.s, email: parsed.e };
    return null;
  } catch {
    return null;
  }
}

/** Absolute, for an email body. */
export function unsubscribeUrl(token: string): string {
  return siteUrl(`/unsubscribe?t=${encodeURIComponent(token)}`);
}

/** The one shape `unsubscribes.address_normalised` holds, matching the readers' `lower(trim(...))`. */
export function normaliseAddress(email: string): string {
  return email.trim().toLowerCase();
}
