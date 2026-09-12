import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  recordBadgeImpression,
  recordBadgeClick,
  drainBadgeCounters,
  closeBadgeCounters,
} from "./counters";

/**
 * Redis db 6, this task's allocation. The counters are global keys, so a test
 * against the shared db would drain another worktree's hash out from under it.
 */
const GOOD_URL = "redis://localhost:6380/6";
const DEAD_URL = "redis://127.0.0.1:1";

beforeEach(async () => {
  process.env.REDIS_URL = GOOD_URL;
  await closeBadgeCounters();
  await drainBadgeCounters();
});

afterAll(async () => {
  process.env.REDIS_URL = GOOD_URL;
  await drainBadgeCounters();
  await closeBadgeCounters();
});

describe("badge counters", () => {
  it("counts impressions and clicks per listing and hands them over once", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await recordBadgeImpression(a);
    await recordBadgeImpression(a);
    await recordBadgeImpression(b);
    await recordBadgeClick(a);

    const drained = await drainBadgeCounters();
    const byListing = new Map(drained.map((d) => [d.listingId, d]));
    expect(byListing.get(a)).toEqual({ listingId: a, impressions: 2, clicks: 1 });
    expect(byListing.get(b)).toEqual({ listingId: b, impressions: 1, clicks: 0 });
  });

  it("empties the counters, so a second flush does not double-count", async () => {
    const id = randomUUID();
    await recordBadgeImpression(id);
    expect(await drainBadgeCounters()).toHaveLength(1);
    expect(await drainBadgeCounters()).toEqual([]);
  });

  it("returns nothing when nothing has happened", async () => {
    expect(await drainBadgeCounters()).toEqual([]);
  });

  it("counts a click with no impression", async () => {
    const id = randomUUID();
    await recordBadgeClick(id);
    expect(await drainBadgeCounters()).toEqual([{ listingId: id, impressions: 0, clicks: 1 }]);
  });

  it("never throws when Redis is unreachable — a badge still renders", async () => {
    process.env.REDIS_URL = DEAD_URL;
    await closeBadgeCounters();
    await expect(recordBadgeImpression(randomUUID())).resolves.toBeUndefined();
    await expect(recordBadgeClick(randomUUID())).resolves.toBeUndefined();
    await expect(drainBadgeCounters()).resolves.toEqual([]);
  });
});
