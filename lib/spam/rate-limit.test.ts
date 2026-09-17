import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rateLimit, RATE_LIMIT_MEMORY_MAX_ENTRIES } from "./rate-limit";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";

const GOOD_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
const DEAD_URL = "redis://127.0.0.1:1";

beforeEach(() => { process.env.REDIS_URL = GOOD_URL; });

describe("rateLimit", () => {
  it("does not write a counter, and always allows, when the key is null", async () => {
    // A null key means the caller could not identify a subject to count
    // against (see rateLimitSubject). There is nothing to rate-limit, so
    // this must not touch Redis or the in-process fallback at all.
    const opts = { limit: 1, windowSeconds: 60 };
    for (let i = 0; i < 5; i++) {
      expect(await rateLimit(null, opts)).toEqual({
        allowed: true,
        remaining: opts.limit,
        retryAfterSeconds: 0,
      });
    }
  });

  it("allows up to the limit then blocks", async () => {
    const key = `test:${randomUUID()}`;
    const opts = { limit: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) {
      expect((await rateLimit(key, opts)).allowed).toBe(true);
    }
    const blocked = await rateLimit(key, opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts separate keys separately", async () => {
    const opts = { limit: 1, windowSeconds: 60 };
    const a = `test:${randomUUID()}`, b = `test:${randomUUID()}`;
    expect((await rateLimit(a, opts)).allowed).toBe(true);
    expect((await rateLimit(b, opts)).allowed).toBe(true);
    expect((await rateLimit(a, opts)).allowed).toBe(false);
  });

  it("reports remaining accurately", async () => {
    const key = `test:${randomUUID()}`;
    const opts = { limit: 5, windowSeconds: 60 };
    expect((await rateLimit(key, opts)).remaining).toBe(4);
    expect((await rateLimit(key, opts)).remaining).toBe(3);
  });
});

/**
 * Each of these needs its own module instance: the Redis client and the
 * "Redis is down" cooldown are module state, and a test that marks Redis dead
 * would otherwise decide the outcome of every test after it.
 */
async function freshRateLimit(url: string) {
  vi.resetModules();
  process.env.REDIS_URL = url;
  const mod = await import("./rate-limit");
  return mod.rateLimit;
}

describe("rateLimit when Redis is unreachable", () => {
  // Only Date is frozen: the Redis client still needs real timers to fail.
  //
  // Every call here is a fixed-window count, and the first call against a dead
  // Redis spends ~1.2s (four refused connects with backoff) before it counts.
  // On a wall clock that is long enough to cross a 60s window boundary, and
  // then the second call lands in a fresh window and the assertions are wrong
  // about 2% of the time. A frozen clock cannot roll the window.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("still counts, in process, rather than failing open", async () => {
    // Failing open was the old behaviour: one dead cache and the submit form
    // becomes an unmetered write endpoint.
    const limited = await freshRateLimit(DEAD_URL);
    const key = `test:${randomUUID()}`;
    const opts = { limit: 2, windowSeconds: 60 };

    expect(await limited(key, opts)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await limited(key, opts)).toMatchObject({ allowed: true, remaining: 0 });

    const blocked = await limited(key, opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps the in-process fallback's keys separate", async () => {
    const limited = await freshRateLimit(DEAD_URL);
    const opts = { limit: 1, windowSeconds: 60 };
    const a = `test:${randomUUID()}`, b = `test:${randomUUID()}`;
    expect((await limited(a, opts)).allowed).toBe(true);
    expect((await limited(b, opts)).allowed).toBe(true);
    expect((await limited(a, opts)).allowed).toBe(false);
  });

  it("caps the in-process fallback map so an outage cannot grow memory without bound", async () => {
    const limited = await freshRateLimit(DEAD_URL);
    const opts = { limit: 5, windowSeconds: 60 };
    const first = `test:${randomUUID()}`;

    // Establish `first` as the oldest entry in the map.
    expect((await limited(first, opts)).remaining).toBe(4);

    // Fill the map to capacity with distinct keys so it must evict to admit
    // any more — `first` is the oldest, so it goes first.
    for (let i = 0; i < RATE_LIMIT_MEMORY_MAX_ENTRIES; i++) {
      await limited(`test:${randomUUID()}`, opts);
    }

    // Evicted, so counting on `first` starts over instead of continuing
    // from where it left off.
    expect((await limited(first, opts)).remaining).toBe(4);
  }, 20000);

  it("remembers the failure instead of reconnecting on every single call", async () => {
    // A 3s connect timeout on every submit is a broken form in all but name.
    const limited = await freshRateLimit(DEAD_URL);
    const key = `test:${randomUUID()}`;
    const opts = { limit: 5, windowSeconds: 60 };

    await limited(key, opts);
    // Redis is back — but we are inside the cooldown, so the next call must
    // still use the in-process counter (a fresh Redis key would say 4).
    process.env.REDIS_URL = GOOD_URL;
    expect((await limited(key, opts)).remaining).toBe(3);
  });

  it("retries the connection once the cooldown has passed", async () => {
    const limited = await freshRateLimit(DEAD_URL);
    const key = `test:${randomUUID()}`;
    const opts = { limit: 5, windowSeconds: 3600 };
    await limited(key, opts);

    process.env.REDIS_URL = GOOD_URL;
    vi.setSystemTime(Date.now() + 31_000);
    // Back on Redis: a key nothing has touched before, so it counts from one.
    expect((await limited(key, opts)).remaining).toBe(4);
  });
});

/**
 * A Redis client whose connect() settles only when the test says so, so the
 * window between "connect started" and "connect settled" can be held open and
 * examined instead of raced against a real socket.
 */
function fakeRedisClient() {
  let resolveConnect!: () => void;
  let rejectConnect!: (err: Error) => void;
  const connect = new Promise<void>((resolve, reject) => {
    resolveConnect = resolve;
    rejectConnect = reject;
  });
  const counts = new Map<string, number>();
  const client = {
    isReady: false,
    on() {},
    connect: () => connect,
    incr: async (k: string) => {
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return n;
    },
    expire: async () => true,
    ttl: async () => 60,
  };
  return {
    client,
    counts,
    connected() { client.isReady = true; resolveConnect(); },
    refused() { rejectConnect(new Error("ECONNREFUSED")); },
  };
}

/**
 * The value `p` settled to once every microtask has run, or null if it is
 * still pending — i.e. blocked on something outside the microtask queue (a
 * socket, a timer). The in-process path has neither, so it must settle here.
 */
async function settledThisTick<T>(p: Promise<T>): Promise<{ value: T } | null> {
  let settled: { value: T } | null = null;
  void p.then((value) => { settled = { value }; });
  await setImmediate();
  return settled;
}

describe("rateLimit while a Redis connect is in flight", () => {
  let fake: ReturnType<typeof fakeRedisClient>;
  let limited: typeof rateLimit;

  beforeEach(async () => {
    fake = fakeRedisClient();
    vi.doMock("@redis/client", () => ({ createClient: () => fake.client }));
    limited = await freshRateLimit(GOOD_URL);
  });
  afterEach(() => { vi.doUnmock("@redis/client"); });

  it("counts calls in process at once instead of queueing them behind the connect", async () => {
    const key = `test:${randomUUID()}`;
    const opts = { limit: 2, windowSeconds: 60 };

    // The first call starts the connect and waits on it: Redis, when it comes
    // up, is the counter that matters, and a cold start is a few milliseconds.
    const first = limited(key, opts);
    expect(await settledThisTick(first)).toBeNull();

    // Every call that arrives while that connect is pending is counted now, in
    // process. Waiting on the connect would hold a submit for up to the full
    // connect timeout, times the reconnect attempts — the hang the cooldown
    // exists to prevent, paid by every request in the window instead of one.
    expect(await settledThisTick(limited(key, opts))).toEqual({
      value: { allowed: true, remaining: 1, retryAfterSeconds: expect.any(Number) },
    });
    expect(await settledThisTick(limited(key, opts))).toEqual({
      value: { allowed: true, remaining: 0, retryAfterSeconds: expect.any(Number) },
    });
    expect((await settledThisTick(limited(key, opts)))?.value.allowed).toBe(false);

    // The connect fails: the first call falls back to the same in-process
    // counter the others used, so it is the fourth hit on the key, not a
    // fresh first one.
    fake.refused();
    expect((await first).allowed).toBe(false);
  });

  it("hands over to Redis, as the authoritative counter, once the connect succeeds", async () => {
    const key = `test:${randomUUID()}`;
    const opts = { limit: 2, windowSeconds: 60 };

    const first = limited(key, opts);
    expect((await settledThisTick(limited(key, opts)))?.value.remaining).toBe(1);

    fake.connected();
    // The initiating call reaches Redis, and so does everything after it. The
    // in-process count taken during the connect is not carried over: Redis is
    // the shared counter, and a per-process number has no place in it.
    expect((await first).remaining).toBe(1);
    expect((await limited(key, opts)).remaining).toBe(0);
    expect([...fake.counts.values()]).toEqual([2]);
  });
});
