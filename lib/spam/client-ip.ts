/**
 * The client's IP, as far as anything can be trusted.
 *
 * `CF-Connecting-IP` is honoured ONLY when `TRUST_CF_CONNECTING_IP=true`.
 * Behind Cloudflare it is the one header a visitor cannot write (Cloudflare
 * sets it on every proxied request and strips any copy the client sent), and
 * the last `X-Forwarded-For` hop is Cloudflare's own edge — one address shared
 * by everybody, which would put the whole internet in one rate-limit bucket.
 * Without Cloudflare nothing strips it, so a client can send the header itself
 * and name its own bucket on every request: every `limitPublicWrite` budget,
 * the beacon's one-view-per-day mark and the `ip` on audit rows would then be
 * whatever the sender chose. Trusting it has to be a deliberate switch, set
 * only on a deploy whose origin is reachable through Cloudflare alone.
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
/** Only the one switch is read; typed narrowly so tests can pass `{}`. */
type ClientIpEnv = { TRUST_CF_CONNECTING_IP?: string | undefined };

export function clientIp(headers: Headers, env: ClientIpEnv = process.env): string | null {
  if (env.TRUST_CF_CONNECTING_IP === "true") {
    const cloudflare = headers.get("cf-connecting-ip")?.trim();
    if (cloudflare !== undefined && cloudflare !== "") return cloudflare;
  }

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
