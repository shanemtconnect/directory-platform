/**
 * Cloudflare Turnstile verification.
 *
 * When no secret is configured — local development and staging — verification
 * is SKIPPED and says so. It never silently passes in production: `required`
 * is true whenever a secret exists, so a misconfigured production deploy fails
 * closed rather than accepting every bot.
 */
export interface TurnstileResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
}

export async function verifyTurnstile(
  token: string | null,
  remoteIp?: string,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || secret.trim() === "") {
    return { ok: true, skipped: true, reason: "no TURNSTILE_SECRET_KEY configured" };
  }
  if (!token) return { ok: false, skipped: false, reason: "missing token" };

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    return json.success === true
      ? { ok: true, skipped: false }
      : { ok: false, skipped: false, reason: (json["error-codes"] ?? []).join(",") || "rejected" };
  } catch (e) {
    // A Cloudflare outage must not take the contact form down with it.
    return { ok: true, skipped: true, reason: `verification unreachable: ${String(e)}` };
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
