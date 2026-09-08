import { randomUUID } from "node:crypto";

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

/**
 * What to count against. An unidentifiable request gets a bucket of its own,
 * so it is never blocked by — and never blocks — anyone else.
 */
export function rateLimitSubject(ip: string | null): string {
  return ip ?? `anon:${randomUUID()}`;
}
