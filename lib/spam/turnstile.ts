/**
 * Cloudflare Turnstile verification.
 *
 * Two rules, and the second is the one that used to be wrong.
 *
 *  - No secret configured: verification is SKIPPED, but only outside
 *    production. The gate is `NODE_ENV !== "production"`, so it is LOCAL and
 *    the test suite that run without a key — not staging. A staging container
 *    is a production build with `NODE_ENV=production`, so it fails closed too
 *    and every enquiry on it is rejected until a secret is set. That is the
 *    right way round (a deploy that lost its secret must not quietly accept
 *    every bot), so give staging Cloudflare's published always-pass testing
 *    keys rather than relaxing the check: site `1x00000000000000000000AA`,
 *    secret `1x0000000000000000000000000000000AA`.
 *  - Cloudflare unreachable, or slow: fails CLOSED. An outage that leaves the
 *    form open is an open door with a queue of bots already outside it, and the
 *    person who came to send an enquiry can try again in a minute.
 */
export interface TurnstileResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
}

/** Long enough for a round trip to Cloudflare, short enough to not hang a form post. */
export const TURNSTILE_TIMEOUT_MS = 5000;

const ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** One line in the log, not one per request: a misconfigured deploy fails every submit. */
let warnedNotConfigured = false;

export async function verifyTurnstile(
  token: string | null,
  remoteIp?: string,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || secret.trim() === "") {
    if (process.env.NODE_ENV !== "production") {
      return { ok: true, skipped: true, reason: "no TURNSTILE_SECRET_KEY configured" };
    }
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.error(
        "[turnstile] TURNSTILE_SECRET_KEY is not set in production. " +
          "Every form submission will be rejected until it is.",
      );
    }
    return { ok: false, skipped: false, reason: "not-configured" };
  }
  if (!token) return { ok: false, skipped: false, reason: "missing token" };

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    return json.success === true
      ? { ok: true, skipped: false }
      : { ok: false, skipped: false, reason: (json["error-codes"] ?? []).join(",") || "rejected" };
  } catch {
    return { ok: false, skipped: false, reason: "unreachable" };
  }
}

/**
 * Bots fill every field they find. A field a human never sees but a bot does
 * catches a large share of automated submissions at zero cost to real users
 * and with no accessibility penalty when hidden correctly.
 */
export function isHoneypotTripped(value: FormDataEntryValue | null): boolean {
  return typeof value === "string" && value.trim() !== "";
}
