import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
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

/**
 * A Redis client whose connect() settles only when the test says so, with an
 * in-memory hIncrBy, so the window between "connect started" and "connect
 * settled" can be held open and the buffer's behaviour in it examined.
 */
function fakeRedisClient() {
  let resolveConnect!: () => void;
  let rejectConnect!: (err: Error) => void;
  const connect = new Promise<void>((resolve, reject) => {
    resolveConnect = resolve;
    rejectConnect = reject;
  });
  const hashes = new Map<string, Map<string, number>>();
  let failWrites = false;
  const client = {
    isReady: false,
    on() {},
    connect: () => connect,
    destroy() {},
    close: async () => {},
    hIncrBy: async (hash: string, field: string, n: number) => {
      // Throws BEFORE applying: the benign half of a rejected write. The
      // other half — applied, then the reply lost — looks identical to the
      // caller, which is why a rejected live write is dropped, not held.
      if (failWrites) throw new Error("connection reset");
      const h = hashes.get(hash) ?? new Map<string, number>();
      h.set(field, (h.get(field) ?? 0) + n);
      hashes.set(hash, h);
      return h.get(field)!;
    },
  };
  return {
    client,
    hashes,
    field: (hash: string, id: string) => hashes.get(hash)?.get(id) ?? 0,
    connected() { client.isReady = true; resolveConnect(); },
    refused() { rejectConnect(new Error("ECONNREFUSED")); },
    dropWrites(on: boolean) { failWrites = on; },
  };
}

/** The value `p` settled to once the microtask queue is drained, or null if it is still pending. */
async function settledThisTick<T>(p: Promise<T>): Promise<{ value: T } | null> {
  let settled: { value: T } | null = null;
  void p.then((value) => { settled = { value }; });
  await setImmediate();
  return settled;
}

describe("badge counters while Redis is unavailable", () => {
  const fakes: ReturnType<typeof fakeRedisClient>[] = [];
  let mod: typeof import("./counters");

  beforeEach(async () => {
    fakes.length = 0;
    vi.doMock("@redis/client", () => ({
      createClient: () => {
        const fake = fakeRedisClient();
        fakes.push(fake);
        return fake.client;
      },
    }));
    vi.useFakeTimers({ toFake: ["Date"] });
    // Own module instances: the shared client and the buffer are module state.
    vi.resetModules();
    process.env.REDIS_URL = GOOD_URL;
    mod = await import("./counters");
  });
  afterEach(() => {
    vi.doUnmock("@redis/client");
    vi.useRealTimers();
  });

  it("holds hits that arrive during the connect and writes them once it lands", async () => {
    const id = randomUUID();

    // The first hit starts the connect and waits on it.
    const first = mod.recordBadgeImpression(id);
    expect(await settledThisTick(first)).toBeNull();

    // The next two do not queue behind it: they settle now and are held.
    expect(await settledThisTick(mod.recordBadgeImpression(id))).toEqual({ value: undefined });
    expect(await settledThisTick(mod.recordBadgeClick(id))).toEqual({ value: undefined });
    expect(fakes[0]!.hashes.size).toBe(0);

    fakes[0]!.connected();
    await first;
    // The held hits went first, then the initiator's own.
    expect(fakes[0]!.field(mod.IMPRESSION_HASH, id)).toBe(2);
    expect(fakes[0]!.field(mod.CLICK_HASH, id)).toBe(1);
  });

  it("keeps hits through a refused connect and writes them after the cooldown", async () => {
    const id = randomUUID();
    const first = mod.recordBadgeImpression(id);
    fakes[0]!.refused();
    await first;
    // Cooling down: nothing reconnects, but nothing is dropped either.
    await mod.recordBadgeImpression(id);
    await mod.recordBadgeClick(id);
    expect(fakes).toHaveLength(1);

    vi.setSystemTime(Date.now() + 31_000);
    const retry = mod.recordBadgeImpression(id);
    expect(fakes).toHaveLength(2);
    fakes[1]!.connected();
    await retry;
    expect(fakes[1]!.field(mod.IMPRESSION_HASH, id)).toBe(3);
    expect(fakes[1]!.field(mod.CLICK_HASH, id)).toBe(1);
  });

  it("drains what was held, not just what is in Redis", async () => {
    const id = randomUUID();
    const first = mod.recordBadgeImpression(id);
    fakes[0]!.refused();
    await first;
    await mod.recordBadgeClick(id);

    // Redis is back and the worker's flush is the first thing to notice.
    vi.setSystemTime(Date.now() + 31_000);
    const drain = mod.drainBadgeCounters();
    fakes[1]!.connected();
    // drainHash needs rename/pExpire/hGetAll/del; this fake has none, so the
    // drain itself throws and reports nothing — the assertion is on what the
    // flush wrote first.
    expect(await drain).toEqual([]);
    expect(fakes[1]!.field(mod.IMPRESSION_HASH, id)).toBe(1);
    expect(fakes[1]!.field(mod.CLICK_HASH, id)).toBe(1);
  });

  it("drops a hit whose write fails on a live connection: it may already have been counted", async () => {
    // Held only when nothing was sent. A write that reached the socket and
    // rejected may have landed; replaying it would risk a double, and a lost
    // count beats a doubled one (`lib/redis/buffer.ts` header).
    const id = randomUUID();
    const first = mod.recordBadgeImpression(id);
    fakes[0]!.connected();
    await first;
    expect(fakes[0]!.field(mod.IMPRESSION_HASH, id)).toBe(1);

    fakes[0]!.dropWrites(true);
    await expect(mod.recordBadgeImpression(id)).resolves.toBeUndefined();
    expect(fakes[0]!.field(mod.IMPRESSION_HASH, id)).toBe(1);

    fakes[0]!.dropWrites(false);
    await mod.recordBadgeImpression(id);
    expect(fakes[0]!.field(mod.IMPRESSION_HASH, id)).toBe(2);
  });

  it("replays a held hit at most twice before giving it up", async () => {
    const id = randomUUID();
    const first = mod.recordBadgeImpression(id);
    fakes[0]!.refused();
    await first;
    // One hit held during the cooldown.
    expect(fakes).toHaveLength(1);

    vi.setSystemTime(Date.now() + 31_000);
    const retry = mod.recordBadgeImpression(id);
    fakes[1]!.dropWrites(true);
    fakes[1]!.connected();
    // Replay 1 rejects (put back); the initiator's own write rejects (dropped).
    await retry;
    // Replay 2 rejects (given up); this call's own write rejects (dropped).
    await mod.recordBadgeImpression(id);

    fakes[1]!.dropWrites(false);
    await mod.recordBadgeImpression(id);
    // Only the last hit landed: the held one was abandoned, not doubled.
    expect(fakes[1]!.field(mod.IMPRESSION_HASH, id)).toBe(1);
  });
});
