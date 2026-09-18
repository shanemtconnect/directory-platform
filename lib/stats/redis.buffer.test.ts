import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setImmediate } from "node:timers/promises";

/**
 * What `statsRedis()` does while the shared client is away: a connect in
 * flight, or the down-cooldown after a refused one. Real Redis cannot be held
 * in that state on demand, so `@redis/client` is replaced with a client whose
 * `connect()` settles only when the test says so. The commands' behaviour
 * against real Redis is `redis.test.ts`'s job.
 */

function fakeRedisClient() {
  let resolveConnect!: () => void;
  let rejectConnect!: (err: Error) => void;
  const connect = new Promise<void>((resolve, reject) => {
    resolveConnect = resolve;
    rejectConnect = reject;
  });
  const counts = new Map<string, number>();
  const expires = new Map<string, number>();
  let failWrites = false;
  const client = {
    isReady: false,
    on() {},
    connect: () => connect,
    destroy() {},
    close: async () => {},
    incr: async (key: string) => {
      // Throws BEFORE applying — the benign half of a rejected write.
      if (failWrites) throw new Error("connection reset");
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n;
    },
    incrBy: async (key: string, by: number) => {
      if (failWrites) throw new Error("connection reset");
      const n = (counts.get(key) ?? 0) + by;
      counts.set(key, n);
      return n;
    },
    expire: async (key: string, seconds: number) => {
      expires.set(key, seconds);
      return true;
    },
    set: async (key: string, value: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && counts.has(key)) return null;
      counts.set(key, Number(value));
      return "OK";
    },
  };
  return {
    client,
    counts,
    expires,
    connected() {
      client.isReady = true;
      resolveConnect();
    },
    refused() {
      rejectConnect(new Error("ECONNREFUSED"));
    },
    dropWrites(on: boolean) {
      failWrites = on;
    },
  };
}

/** The value `p` settled to once the microtask queue is drained, or null if it is still pending. */
async function settledThisTick<T>(p: Promise<T>): Promise<{ value: T } | null> {
  let settled: { value: T } | null = null;
  void p.then((value) => {
    settled = { value };
  });
  await setImmediate();
  return settled;
}

const fakes: ReturnType<typeof fakeRedisClient>[] = [];
let mod: typeof import("./redis");

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
  vi.resetModules();
  process.env.REDIS_URL = "redis://localhost:6380/12";
  mod = await import("./redis");
});
afterEach(() => {
  vi.doUnmock("@redis/client");
  vi.useRealTimers();
});

describe("statsRedis while the shared client is away", () => {
  it("is a client, not null, when Redis is configured but not (yet) reachable", async () => {
    expect(await mod.statsRedis()).not.toBeNull();
  });

  it("is still null when nothing is configured", async () => {
    delete process.env.REDIS_URL;
    expect(await mod.statsRedis()).toBeNull();
  });

  it("holds INCRs that arrive during the connect and writes them, TTL included, once it lands", async () => {
    const c = (await mod.statsRedis())!;
    const key = "stats:listing:day:view";

    // The first INCR starts the connect and waits on it.
    const first = c.incr(key);
    expect(await settledThisTick(first)).toBeNull();

    // The next two settle at once, counted in process; the caller sees a
    // fresh key and asks for a TTL, exactly as it would against Redis.
    expect(await settledThisTick(c.incr(key))).toEqual({ value: 1 });
    expect(await settledThisTick(c.expire(key, 60))).toEqual({ value: undefined });
    expect(await settledThisTick(c.incr(key))).toEqual({ value: 2 });
    expect(fakes[0]!.counts.size).toBe(0);

    fakes[0]!.connected();
    // The two held hits land first as one INCRBY, the key is fresh in Redis
    // so the held TTL is applied, and then the initiator's own INCR runs.
    expect(await first).toBe(3);
    expect(fakes[0]!.counts.get(key)).toBe(3);
    expect(fakes[0]!.expires.get(key)).toBe(60);
  });

  it("leaves the TTL alone when the flush finds the key already in Redis", async () => {
    const c = (await mod.statsRedis())!;
    const key = "stats:listing:day:view";

    const first = c.incr(key);
    await settledThisTick(c.incr(key));
    await settledThisTick(c.expire(key, 60));

    // Another process counted this key while we were away: it has its TTL.
    fakes[0]!.counts.set(key, 5);
    fakes[0]!.connected();
    expect(await first).toBe(7);
    expect(fakes[0]!.expires.has(key)).toBe(false);
  });

  it("keeps counting through a refused connect and writes after the cooldown", async () => {
    const c = (await mod.statsRedis())!;
    const key = "stats:listing:day:view";

    const first = c.incr(key);
    fakes[0]!.refused();
    expect(await first).toBe(1);
    expect(await c.incr(key)).toBe(2);
    expect(fakes).toHaveLength(1);

    vi.setSystemTime(Date.now() + 31_000);
    const retry = c.incr(key);
    expect(fakes).toHaveLength(2);
    fakes[1]!.connected();
    expect(await retry).toBe(3);
    expect(fakes[1]!.counts.get(key)).toBe(3);
  });

  it("lets an INCR that rejects on a live connection throw, rather than holding it", async () => {
    // Held only when nothing was sent. A rejected live write may have landed;
    // the caller (`recordStats`) treats the throw as a lost view, as before.
    const c = (await mod.statsRedis())!;
    const key = "stats:listing:day:view";
    const first = c.incr(key);
    fakes[0]!.connected();
    expect(await first).toBe(1);

    fakes[0]!.dropWrites(true);
    await expect(c.incr(key)).rejects.toThrow();
    fakes[0]!.dropWrites(false);
    // Nothing was held: the next INCR is the second, not the third.
    expect(await c.incr(key)).toBe(2);
  });

  it("replays a held count at most twice before giving it up", async () => {
    const c = (await mod.statsRedis())!;
    const key = "stats:listing:day:view";
    const first = c.incr(key);
    fakes[0]!.refused();
    expect(await first).toBe(1);
    // One count held through the cooldown.

    vi.setSystemTime(Date.now() + 31_000);
    const retry = c.incr(key);
    fakes[1]!.dropWrites(true);
    fakes[1]!.connected();
    // Replay 1 rejects (put back); the initiator's own INCR rejects.
    await expect(retry).rejects.toThrow();
    // Replay 2 rejects (given up); this INCR rejects too.
    await expect(c.incr(key)).rejects.toThrow();

    fakes[1]!.dropWrites(false);
    // Only this INCR lands: the held count was abandoned, never doubled.
    expect(await c.incr(key)).toBe(1);
  });

  it("answers a daily-view claim with yes while Redis is away", async () => {
    // The mark guards a counter; with Redis away the counter is held, not
    // written, and a held view is better than a dropped one.
    const c = (await mod.statsRedis())!;
    void c.incr("stats:warm");
    expect(await settledThisTick(c.setIfAbsent("stats:seen:x", "1", 60))).toEqual({ value: true });
  });

  it("refuses a SCAN or GETDEL while Redis is away rather than answering with nothing", async () => {
    // A drain that got an empty page here would believe there was nothing to
    // flush. It gets a rejection, which it already treats as "try later".
    const c = (await mod.statsRedis())!;
    void c.incr("stats:warm");
    await expect(c.scan("0", "stats:*", 100)).rejects.toThrow();
    await expect(c.takeAll(["stats:a"])).rejects.toThrow();
    await expect(c.get("stats:a")).rejects.toThrow();
  });
});
