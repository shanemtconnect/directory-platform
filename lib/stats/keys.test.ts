import { describe, expect, it } from "vitest";
import {
  BEACON_METRICS,
  METRIC_COLUMN,
  STAT_METRICS,
  STATS_KEY_PREFIX,
  dayKey,
  dayRange,
  isBeaconMetric,
  isUuid,
  parseStatsKey,
  statsKey,
} from "./keys";

describe("dayKey", () => {
  it("formats as YYYY-MM-DD", () => {
    expect(dayKey(new Date("2026-09-12T10:00:00Z"))).toBe("2026-09-12");
  });

  it("uses the site timezone, not UTC", () => {
    // 23:30 UTC on 11 June is 00:30 on the 12th in Europe/London (BST). An
    // owner's dashboard must agree with the owner's calendar, so the bucket
    // is the site's day, not the server's.
    expect(dayKey(new Date("2026-06-11T23:30:00Z"), "Europe/London")).toBe("2026-06-12");
    expect(dayKey(new Date("2026-06-11T23:30:00Z"), "UTC")).toBe("2026-06-11");
  });

  it("handles a timezone behind UTC", () => {
    expect(dayKey(new Date("2026-06-12T02:00:00Z"), "America/New_York")).toBe("2026-06-11");
  });
});

describe("dayRange", () => {
  it("returns `days` consecutive days ending today, ascending", () => {
    const r = dayRange(new Date("2026-09-12T10:00:00Z"), 3, "UTC");
    expect(r).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"]);
  });

  it("crosses a month boundary", () => {
    expect(dayRange(new Date("2026-03-02T10:00:00Z"), 3, "UTC")).toEqual([
      "2026-02-28", "2026-03-01", "2026-03-02",
    ]);
  });

  it("never returns fewer than one day", () => {
    expect(dayRange(new Date("2026-09-12T10:00:00Z"), 0, "UTC")).toEqual(["2026-09-12"]);
  });
});

describe("statsKey / parseStatsKey", () => {
  const id = "11111111-2222-4333-8444-555555555555";

  it("round-trips", () => {
    const key = statsKey(id, "2026-09-12", "view");
    expect(key).toBe(`${STATS_KEY_PREFIX}${id}:2026-09-12:view`);
    expect(parseStatsKey(key)).toEqual({ listingId: id, day: "2026-09-12", metric: "view" });
  });

  it("carries no personal data — a listing uuid, a day and a metric name only", () => {
    expect(statsKey(id, "2026-09-12", "view").split(":")).toHaveLength(4);
  });

  it("refuses a key from another namespace", () => {
    expect(parseStatsKey(`ratelimit:${id}:2026-09-12:view`)).toBeNull();
  });

  it("refuses a malformed listing id, day or metric", () => {
    expect(parseStatsKey(`${STATS_KEY_PREFIX}not-a-uuid:2026-09-12:view`)).toBeNull();
    expect(parseStatsKey(`${STATS_KEY_PREFIX}${id}:12-09-2026:view`)).toBeNull();
    expect(parseStatsKey(`${STATS_KEY_PREFIX}${id}:2026-09-12:drop-table`)).toBeNull();
    expect(parseStatsKey(`${STATS_KEY_PREFIX}${id}:2026-09-12`)).toBeNull();
  });
});

describe("metrics", () => {
  it("maps every metric to a listing_stats_daily column", () => {
    for (const m of STAT_METRICS) expect(METRIC_COLUMN[m]).toBeTruthy();
  });

  it("accepts only view and impression from the public beacon", () => {
    expect([...BEACON_METRICS]).toEqual(["view", "impression"]);
    expect(isBeaconMetric("view")).toBe(true);
    expect(isBeaconMetric("impression")).toBe(true);
    // Counted at their write sites, never from a request anyone can forge.
    expect(isBeaconMetric("enquiry")).toBe(false);
    expect(isBeaconMetric("shortlist_add")).toBe(false);
    expect(isBeaconMetric("")).toBe(false);
  });
});

describe("isUuid", () => {
  it("accepts a uuid and rejects everything else", () => {
    expect(isUuid("11111111-2222-4333-8444-555555555555")).toBe(true);
    expect(isUuid("11111111-2222-4333-8444-55555555555")).toBe(false);
    expect(isUuid("'; drop table listings; --")).toBe(false);
  });
});
