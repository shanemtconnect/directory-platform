/**
 * Where a sign-in sends somebody afterwards.
 *
 * `/login?next=…` is a parameter a stranger controls and hands to a victim, so
 * it is the classic open-redirect hole: an attacker mails
 * `/login?next=https://evil.example/` and the phish inherits our domain's
 * reputation and the trust the visitor just spent a password on. The only
 * thing accepted here is a path on this site, and everything else — including
 * the near misses browsers normalise into an absolute URL — falls back.
 *
 * Validated rather than escaped, and validated in ONE place: the login form,
 * the signup form, the account layout and the claim ladder all read the same
 * parameter, and four hand-rolled checks would eventually disagree.
 */

/** Where a person goes when there is nowhere in particular to send them. */
export const DEFAULT_NEXT = "/account";

/**
 * The pages that must never be a destination.
 *
 * `/login?next=/login` is a loop, and the reset and verify links are single
 * use — returning to one after it has been spent shows a person an error for
 * something that actually worked. Matched as a whole path segment so
 * `/login-help` is still a page somebody can be sent to.
 */
const AUTH_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password", "/verify-email"];

/** Long enough for any real path; short enough that nobody is smuggling a payload. */
const MAX_LENGTH = 512;

function isSafePath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_LENGTH) return false;

  // Control characters and spaces: browsers strip tab, CR and LF from a URL
  // before parsing it, so "/\n/evil.example" is loaded as "//evil.example".
  if (/[\u0000-\u0020\u007f]/.test(value)) return false;

  // A backslash is an authority-position slash to every browser, so "/\evil"
  // is "//evil". Nothing legitimate in a path needs one unescaped.
  if (value.includes("\\")) return false;

  // One leading slash and no second one: that is what makes it same-origin.
  // "//evil.example" is a protocol-relative URL, not a path.
  if (!value.startsWith("/") || value.startsWith("//")) return false;

  const path = value.split(/[?#]/, 1)[0]!;
  // `/../` would resolve above the root; there is no reason for it in a link
  // we generated ourselves.
  if (path.split("/").includes("..")) return false;

  // Next normalises `/login/` to `/login` before routing, so the trailing
  // slash must not be enough to slip an auth page past the list.
  return !AUTH_PATHS.includes(path.replace(/\/+$/, "") || "/");
}

/**
 * `value` is whatever `searchParams` produced: a string, the array Next hands
 * back for a repeated key, or nothing at all. The array takes its FIRST entry
 * rather than being stringified — `?next=/a&next=//evil.example` must not
 * become the string "/a,//evil.example" and squeak past a startsWith check.
 */
export function safeNext(value: unknown, fallback: string = DEFAULT_NEXT): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return fallback;
  return isSafePath(raw) ? raw : fallback;
}

/** `/login?next=…`, with the parameter left off when it would say nothing. */
export function loginPath(next: string, base: string = "/login"): string {
  if (next === DEFAULT_NEXT) return base;
  return `${base}?next=${encodeURIComponent(next)}`;
}
