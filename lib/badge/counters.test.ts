import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  recordBadgeImpression,
  recordBadgeClick,
  drainBadgeCounters,
  closeBadgeCounters,
  drainHash,
  FLUSH_TEMP_TTL_MS,
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

describe("drainHash", () => {
  /** Just the four commands drainHash uses, recording the order it used them. */
  function fakeClient(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const client = {
      rename: async () => { calls.push("rename"); },
      pExpire: async (_key: string, ms: number) => { calls.push(`pExpire:${ms}`); },
      hGetAll: async () => { calls.push("hGetAll"); return {}; },
      del: async () => { calls.push("del"); },
      ...overrides,
    };
    return { calls, client: client as never };
  }

  it("puts a TTL on the temp key before reading it", async () => {
    const { calls, client } = fakeClient();
    await drainHash(client, "badge:test");
    expect(calls).toEqual(["rename", `pExpire:${FLUSH_TEMP_TTL_MS}`, "hGetAll", "del"]);
  });

  it("leaves the TTL behind when the read fails, so nothing leaks for ever", async () => {
    // The del in the finally is the normal cleanup; if the worker is killed
    // between the rename and the del there is nothing to run it, and Redis is
    // not persisted here, so the expiry is the only thing that reclaims it.
    const { calls, client } = fakeClient({
      hGetAll: async () => { throw new Error("connection reset"); },
      del: async () => { throw new Error("connection reset"); },
    });
    await expect(drainHash(client, "badge:test")).rejects.toThrow();
    expect(calls).toContain(`pExpire:${FLUSH_TEMP_TTL_MS}`);
  });

  it("returns nothing when the hash does not exist", async () => {
    const { client } = fakeClient({ rename: async () => { throw new Error("no such key"); } });
    expect(await drainHash(client, "badge:test")).toEqual({});
  });
});
