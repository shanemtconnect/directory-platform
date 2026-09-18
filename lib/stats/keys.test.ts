import { describe, expect, it } from "vitest";
import {
  BEACON_METRICS,
  MAX_BEACON_EVENTS,
  MAX_BEACON_IMPRESSIONS,
  MAX_BEACON_VIEWS,
  METRIC_COLUMN,
  STAT_METRICS,
  STATS_KEY_PREFIX,
  dayKey,
  dayRange,
  isBeaconMetric,
  isUuid,
  parseStatsKey,
  seenKey,
  seenSubject,
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

  it("never mistakes a per-address view mark for a counter", () => {
    // The marks share the `stats:` namespace so one SCAN covers both, and the
    // flush must skip them: a mark is a flag, not a count, and GETDEL on it
    // would let the same address count again the same day.
    expect(parseStatsKey(seenKey("2026-09-12", "198.51.100.7", id, "salt"))).toBeNull();
    expect(parseStatsKey(seenKey("2026-09-12", "2001:db8::7", id, "salt"))).toBeNull();
  });
});

describe("seenKey", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const ip = "198.51.100.7";
  const salt = "a-secret-nobody-else-knows";

  it("is stats:seen:<day>:<digest>:<listingId>, with the address hashed rather than written", () => {
    const key = seenKey("2026-09-12", ip, id, salt);
    const parts = key.slice(STATS_KEY_PREFIX.length).split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("seen");
    expect(parts[1]).toBe("2026-09-12");
    expect(parts[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(parts[3]).toBe(id);
    expect(key).not.toContain(ip);
  });

  it("never lets an IPv6 address through either", () => {
    const key = seenKey("2026-09-12", "2001:db8::7", id, salt);
    expect(key).not.toContain("2001:db8");
    expect(key.slice(STATS_KEY_PREFIX.length).split(":")).toHaveLength(4);
  });

  it("is the same key for the same address, day and salt", () => {
    expect(seenKey("2026-09-12", ip, id, salt)).toBe(seenKey("2026-09-12", ip, id, salt));
  });

  it("is a different digest for a different day, so nothing links one day's mark to the next", () => {
    const a = seenSubject(ip, "2026-09-12", salt);
    const b = seenSubject(ip, "2026-09-13", salt);
    expect(a).not.toBe(b);
  });

  it("is a different digest under a different salt, so the address cannot be looked up from the key", () => {
    expect(seenSubject(ip, "2026-09-12", salt)).not.toBe(seenSubject(ip, "2026-09-12", "other"));
  });

  it("is a different digest for a different address", () => {
    expect(seenSubject(ip, "2026-09-12", salt)).not.toBe(seenSubject("198.51.100.8", "2026-09-12", salt));
  });
});

describe("beacon caps", () => {
  it("allow one view and a page of impressions per beacon", () => {
    // One page is one view; a grid is 24 cards, so 40 impressions covers the
    // largest page the site renders with room to spare.
    expect(MAX_BEACON_VIEWS).toBe(1);
    expect(MAX_BEACON_IMPRESSIONS).toBe(40);
    expect(MAX_BEACON_VIEWS + MAX_BEACON_IMPRESSIONS).toBeLessThanOrEqual(MAX_BEACON_EVENTS);
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
