import { isDayKey, isUuid } from "@/lib/stats/keys";

/**
 * The counter vocabulary for sponsor campaigns. A sibling of `lib/stats/keys`
 * rather than an extension of it: those keys name a listing and flush into
 * `listing_stats_daily`; these name a campaign and flush into
 * `sponsor_stats_daily`. Separate prefixes mean neither drain can ever see
 * the other's keys.
 */
export const SPONSOR_METRICS = ["impression", "click"] as const;
export type SponsorMetric = (typeof SPONSOR_METRICS)[number];

export function isSponsorMetric(v: unknown): v is SponsorMetric {
  return typeof v === "string" && (SPONSOR_METRICS as readonly string[]).includes(v);
}

/**
 * The one metric the public beacon accepts for a campaign. Clicks are counted
 * by `/out/<id>` itself, never from a browser: a number an advertiser is
 * billed against must not be forgeable by POSTing at a public endpoint.
 */
export const SPONSOR_BEACON_METRIC = "sponsor_impression" as const;
export type SponsorBeaconMetric = typeof SPONSOR_BEACON_METRIC;

/** Two rails of five plus an inline card is eleven; a page never carries more. */
export const MAX_BEACON_SPONSOR_IMPRESSIONS = 12;

export const SPONSOR_KEY_PREFIX = "sponsor:";

/** `sponsor:<campaignId>:<YYYY-MM-DD>:<metric>` — a uuid, a date and a word. */
export function sponsorStatsKey(campaignId: string, day: string, metric: SponsorMetric): string {
  return `${SPONSOR_KEY_PREFIX}${campaignId}:${day}:${metric}`;
}

export interface ParsedSponsorKey {
  campaignId: string;
  day: string;
  metric: SponsorMetric;
}

export function parseSponsorStatsKey(key: string): ParsedSponsorKey | null {
  if (!key.startsWith(SPONSOR_KEY_PREFIX)) return null;
  const parts = key.slice(SPONSOR_KEY_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const [campaignId, day, metric] = parts;
  if (!isUuid(campaignId) || !isDayKey(day) || !isSponsorMetric(metric)) return null;
  return { campaignId, day, metric };
}
