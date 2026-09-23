import { createHash } from "node:crypto";
import { siteConfig } from "@/config/site.config";

/**
 * The vocabulary of the stats pipeline: what can be counted, what a Redis
 * counter key looks like, and which day a given instant belongs to.
 *
 * Deliberately free of Redis, the database and `next/*` so both ends of the
 * pipeline — a route handler on the request path and a worker job on a cron —
 * can share it, and so the key format can be tested without either.
 */

/** Every column `listing_stats_daily` counts. */
export const STAT_METRICS = [
  "view",
  "impression",
  "enquiry",
  "shortlist_add",
  "badge_click",
  /** Chosen as a recipient of a broadcast quote request (quoteBroadcast). */
  "quote_request",
] as const;

export type StatMetric = (typeof STAT_METRICS)[number];

/** metric → the `listing_stats_daily` column it accumulates into. */
export const METRIC_COLUMN: Record<StatMetric, string> = {
  view: "views",
  impression: "impressions",
  enquiry: "enquiries",
  shortlist_add: "shortlist_adds",
  badge_click: "badge_clicks",
  quote_request: "quote_requests",
};

/**
 * The only two metrics `/api/beacon` accepts.
 *
 * `enquiry` and `shortlist_add` are counted at their write sites, inside the
 * transaction that writes the row. Accepting them from a public endpoint would
 * let anyone inflate the number a listing owner is shown at renewal time — the
 * one number the whole feature exists to make trustworthy.
 */
export const BEACON_METRICS = ["view", "impression"] as const;
export type BeaconMetric = (typeof BEACON_METRICS)[number];

/**
 * The most events one beacon may carry — one page of cards, well past the
 * largest grid the site renders, and small enough that a forged batch buys
 * almost nothing over a forged single.
 *
 * Lives here rather than in the route so the inline script and the endpoint
 * that validates it cannot drift apart: a script that batches more than the
 * endpoint accepts silently drops the tail of every page.
 */
export const MAX_BEACON_EVENTS = 100;

/**
 * How many of those events may be views: one.
 *
 * A beacon is sent by one page, and one page is one view. The endpoint
 * accepted a hundred of them in a single POST, which turned the per-client
 * rate limit into a multiplier — 120 beacons of 100 views each is 12,000
 * views per ten minutes from one address against any listing id at all.
 */
export const MAX_BEACON_VIEWS = 1;

/**
 * And how many may be impressions: a page of cards.
 *
 * The largest grid the site renders is 24 (`PER_PAGE`, `SEARCH_PER_PAGE`);
 * 40 leaves room for a sidebar of related listings without leaving room for a
 * forged batch to matter. Anything past the cap is dropped, not refused: the
 * script that overshoots is ours, and a 400 would cost the whole page's
 * counts rather than the tail.
 */
export const MAX_BEACON_IMPRESSIONS = 40;

export function isBeaconMetric(v: unknown): v is BeaconMetric {
  return typeof v === "string" && (BEACON_METRICS as readonly string[]).includes(v);
}

export function isStatMetric(v: unknown): v is StatMetric {
  return typeof v === "string" && (STAT_METRICS as readonly string[]).includes(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function isDayKey(v: unknown): v is string {
  return typeof v === "string" && DAY_RE.test(v);
}

/**
 * Namespaced away from the cache (`nextjs:<buildId>:…`) and the rate limiter
 * (`ratelimit:…`) so a SCAN over one can never see the others, and so the
 * cache sweep on boot cannot eat a counter that has not been flushed yet.
 */
export const STATS_KEY_PREFIX = "stats:";

/**
 * `stats:<listingId>:<YYYY-MM-DD>:<metric>`.
 *
 * No IP, no session, no user id, no user agent: a counter key is a listing
 * uuid, a date and a word. There is nothing in Redis to leak, and nothing that
 * would make this personal data if it were.
 */
export function statsKey(listingId: string, day: string, metric: StatMetric): string {
  return `${STATS_KEY_PREFIX}${listingId}:${day}:${metric}`;
}

/**
 * What stands in for an address in a seen-mark: `sha256(ip, day, salt)`.
 *
 * Not the address. A key that names the visitor is personal data sitting in
 * Redis for a day, which is a day longer than any of this needs it. The digest
 * is one-way, and the day is folded in so the same address is a different
 * string tomorrow — nothing in Redis ever links one day's mark to the next.
 * The salt is what keeps a digest from being reversed by hashing every
 * address there is: without it, an IPv4 space is a four-billion-row lookup
 * table somebody has already built. `lib/stats/counters.ts` supplies it from
 * the environment; this function takes it as an argument so the key format
 * stays testable without one.
 *
 * Newlines between the parts, not concatenation: `"1.2.3.4" + "2026-09-12"`
 * and `"1.2.3.42" + "026-09-12"` must not be the same input.
 */
export function seenSubject(ip: string, day: string, salt: string): string {
  return createHash("sha256").update(`${ip}\n${day}\n${salt}`).digest("hex");
}

/**
 * `stats:seen:<YYYY-MM-DD>:<digest>:<listingId>` — the mark that says an
 * address has already been counted as a view of this listing today.
 *
 * SET NX EX 86400, never read back, never joined to anything: a day later it
 * is gone. It exists because the alternative — trusting each client to send
 * one view per listing per day — is no guard at all. The address itself never
 * reaches the key: `seenSubject` above hashes it, so the only way to write a
 * raw address here is to bypass this function. Under the `stats:` prefix on
 * purpose, so the same SCAN discipline (never KEYS, never FLUSHALL) covers it,
 * and the flush's key parser refuses it: a mark is not a count.
 */
export function seenKey(day: string, ip: string, listingId: string, salt: string): string {
  return `${STATS_KEY_PREFIX}seen:${day}:${seenSubject(ip, day, salt)}:${listingId}`;
}

export interface ParsedStatsKey {
  listingId: string;
  day: string;
  metric: StatMetric;
}

/**
 * The inverse, used by the flush. Validates every part rather than trusting
 * the shape: whatever SCAN hands back becomes a database write, and a key
 * nobody in this codebase wrote must not become one.
 */
export function parseStatsKey(key: string): ParsedStatsKey | null {
  if (!key.startsWith(STATS_KEY_PREFIX)) return null;
  const parts = key.slice(STATS_KEY_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const [listingId, day, metric] = parts;
  if (!isUuid(listingId) || !isDayKey(day) || !isStatMetric(metric)) return null;
  return { listingId, day, metric };
}

/**
 * The calendar day an instant falls on, in the site's timezone.
 *
 * `en-CA` because its short date format is exactly ISO `YYYY-MM-DD`; building
 * the string from the parts by hand is the only alternative and this is the
 * one the platform already gets right across DST.
 *
 * Bucketing in UTC would be wrong for the reader: an owner in Europe/London
 * looking at "yesterday" in June means the day their calendar showed, and an
 * hour of it would otherwise be filed under the day before.
 */
export function dayKey(at: Date, timeZone: string = siteConfig.timezone): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * The `days` calendar days ending on `at`, ascending.
 *
 * Walks back in whole UTC days from midday rather than adding local hours:
 * midday is more than a DST shift away from either boundary, so the walk can
 * never skip or repeat a day the way a midnight-anchored one does.
 */
export function dayRange(at: Date, days: number, timeZone: string = siteConfig.timezone): string[] {
  const count = Math.max(1, Math.floor(days));
  const today = dayKey(at, timeZone);
  const anchor = Date.parse(`${today}T12:00:00Z`);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    out.push(new Date(anchor - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}
