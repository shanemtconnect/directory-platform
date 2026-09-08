/**
 * The client's IP, as far as anything can be trusted.
 *
 * `X-Forwarded-For` is a list, and the client writes the left of it. Reading
 * the FIRST entry — which is what this used to do — hands the attacker the
 * rate limiter: they send a different fake leading IP each time and never hit
 * a bucket twice. Only the LAST hop is written by our own proxy, so that is
 * the only entry worth reading.
 *
 * Returns null rather than a placeholder when there is no proxy header at all,
 * because a shared "unknown" bucket is worse than none: one bot in it locks
 * out every other request that lands in it.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((h) => h.trim()).filter((h) => h !== "");
    const last = hops.at(-1);
    if (last !== undefined) return last;
  }

  const real = headers.get("x-real-ip")?.trim();
  return real !== undefined && real !== "" ? real : null;
}

let warnedMissingClientIp = false;

/**
 * What to count against. There is nothing to count an unidentifiable
 * request against: minting it a bucket of its own — as this used to do,
 * `anon:${randomUUID()}` per call — writes a fresh Redis key (or, with
 * Redis down, a fresh in-process Map entry) on every single request with no
 * proxy header, which is an unbounded key generator wearing a rate limiter's
 * clothes. Returning null tells the caller to skip counting entirely; the
 * limit is a no-op for that request either way, since a bucket of one is
 * never full.
 *
 * In production this is worth knowing about — it means requests are
 * reaching the app with no X-Forwarded-For/X-Real-IP, almost always a proxy
 * misconfiguration — so it is logged once per process, not once per
 * request.
 */
export function rateLimitSubject(ip: string | null): string | null {
  if (ip !== null) return ip;

  if (process.env.NODE_ENV === "production" && !warnedMissingClientIp) {
    warnedMissingClientIp = true;
    console.warn(
      "rateLimitSubject: no client IP header (X-Forwarded-For / X-Real-IP) present on a production request; rate limiting is not being applied to these requests",
    );
  }

  return null;
}
