/**
 * The client's IP, as far as anything can be trusted.
 *
 * `CF-Connecting-IP` first. When Cloudflare fronts the site it sets this to
 * the visitor's address on every proxied request and strips any copy the
 * client sent, so it is the one header a visitor cannot write. Behind
 * Cloudflare the last `X-Forwarded-For` hop is Cloudflare's own edge — one
 * address shared by everybody, which would put the whole internet in one
 * rate-limit bucket. Without Cloudflare nothing sets the header, and a client
 * that sends one itself is handing over a name to be limited under, which
 * costs them and not us: the origin proxy still appends the real address to
 * `X-Forwarded-For`, but nothing here reads it when the CF header is present,
 * so a forged CF header only ever changes which bucket the forger spends.
 * (An origin that is NOT behind Cloudflare and wants that door shut should
 * have its proxy strip the header; see the README's environment section.)
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
  const cloudflare = headers.get("cf-connecting-ip")?.trim();
  if (cloudflare !== undefined && cloudflare !== "") return cloudflare;

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
