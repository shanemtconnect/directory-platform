import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setImmediate } from "node:timers/promises";

/**
 * Every test gets its own module instance: the client, the pending connect and
 * the down-cooldown are all module state, and one test marking Redis dead
 * would otherwise decide the outcome of every test after it.
 *
 * `@redis/client` is replaced with a client whose `connect()` settles only
 * when the test says so, so the window between "connect started" and "connect
 * settled" can be held open and examined rather than raced against a socket.
 */

interface FakeClient {
  isReady: boolean;
  on: () => void;
  connect: () => Promise<void>;
  close: () => Promise<void>;
  destroy: () => void;
  closed: number;
  destroyed: number;
}

function fakeRedisClient() {
  let resolveConnect!: () => void;
  let rejectConnect!: (err: Error) => void;
  const connect = new Promise<void>((resolve, reject) => {
    resolveConnect = resolve;
    rejectConnect = reject;
  });
  const client: FakeClient = {
    isReady: false,
    on() {},
    connect: () => connect,
    close: async () => {
      client.isReady = false;
      client.closed += 1;
    },
    destroy: () => {
      client.isReady = false;
      client.destroyed += 1;
    },
    closed: 0,
    destroyed: 0,
  };
  return {
    client,
    connected() {
      client.isReady = true;
      resolveConnect();
    },
    refused() {
      rejectConnect(new Error("ECONNREFUSED"));
    },
  };
}

/** The value `p` settled to once the microtask queue is drained, or null if still pending. */
async function settledThisTick<T>(p: Promise<T>): Promise<{ value: T } | null> {
  let settled: { value: T } | null = null;
  void p.then((value) => {
    settled = { value };
  });
  await setImmediate();
  return settled;
}

const fakes: ReturnType<typeof fakeRedisClient>[] = [];
const createClient = vi.fn(() => {
  const fake = fakeRedisClient();
  fakes.push(fake);
  return fake.client;
});

async function freshClient() {
  vi.resetModules();
  return import("./client");
}

beforeEach(() => {
  fakes.length = 0;
  createClient.mockClear();
  process.env.REDIS_URL = "redis://localhost:6380/12";
  delete process.env.NEXT_PHASE;
  vi.doMock("@redis/client", () => ({ createClient }));
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.doUnmock("@redis/client");
  vi.useRealTimers();
});

describe("getRedis", () => {
  it("is null, without trying to connect, when REDIS_URL is unset", async () => {
    delete process.env.REDIS_URL;
    const { getRedis, redisState } = await freshClient();
    expect(await getRedis()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(redisState().status).toBe("unconfigured");
  });

  it("is null, without trying to connect, during `next build`", async () => {
    // Constraint 4: never connect to Redis during the build.
    process.env.NEXT_PHASE = "phase-production-build";
    const { getRedis } = await freshClient();
    expect(await getRedis()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("makes only the first caller wait for the connect; everyone else gets null at once", async () => {
    const { getRedis, redisState } = await freshClient();

    const first = getRedis();
    expect(await settledThisTick(first)).toBeNull();
    expect(redisState().status).toBe("connecting");

    // Arriving while the connect is pending is somebody else's wait: a null
    // now, not a client after up to the full connect timeout.
    expect(await settledThisTick(getRedis())).toEqual({ value: null });
    expect(await settledThisTick(getRedis())).toEqual({ value: null });
    expect(createClient).toHaveBeenCalledTimes(1);

    fakes[0]!.connected();
    expect(await first).toBe(fakes[0]!.client);
    expect(redisState().status).toBe("ready");
    // From here on the handle is shared and reused.
    expect(await settledThisTick(getRedis())).toEqual({ value: fakes[0]!.client });
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("gives the initiating caller null when the connect is refused, and enters the cooldown", async () => {
    const { getRedis, redisState } = await freshClient();

    const first = getRedis();
    fakes[0]!.refused();
    expect(await first).toBeNull();

    const state = redisState();
    expect(state.status).toBe("down");
    expect(state.downUntil).toBe(Date.now() + 30_000);
    // The client that failed to connect is not left holding a socket.
    expect(fakes[0]!.client.destroyed).toBe(1);
  });

  it("does not reconnect on every call while cooling down", async () => {
    const { getRedis } = await freshClient();
    const first = getRedis();
    fakes[0]!.refused();
    await first;

    for (let i = 0; i < 5; i++) expect(await settledThisTick(getRedis())).toEqual({ value: null });
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("tries again once the cooldown has passed", async () => {
    const { getRedis, redisState } = await freshClient();
    const first = getRedis();
    fakes[0]!.refused();
    await first;

    vi.setSystemTime(Date.now() + 31_000);
    const retry = getRedis();
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(redisState().status).toBe("connecting");
    fakes[1]!.connected();
    expect(await retry).toBe(fakes[1]!.client);
    expect(redisState().status).toBe("ready");
  });

  it("reconnects when a previously ready handle has dropped, and lets the dead one go", async () => {
    const { getRedis } = await freshClient();
    const first = getRedis();
    fakes[0]!.connected();
    await first;

    // node-redis gave up reconnecting on its own: the handle is dead but the
    // module holds it. The next call must open a new one, not return the
    // corpse, and must not leave the corpse's socket behind.
    fakes[0]!.client.isReady = false;
    const again = getRedis();
    expect(createClient).toHaveBeenCalledTimes(2);
    fakes[1]!.connected();
    expect(await again).toBe(fakes[1]!.client);
    expect(fakes[0]!.client.destroyed).toBe(1);
  });
});

describe("closeRedis", () => {
  it("closes the handle, forgets it and clears the cooldown", async () => {
    const { getRedis, closeRedis, redisState } = await freshClient();
    const first = getRedis();
    fakes[0]!.connected();
    await first;

    await closeRedis();
    expect(fakes[0]!.client.closed).toBe(1);
    expect(redisState().status).toBe("disconnected");

    const again = getRedis();
    expect(createClient).toHaveBeenCalledTimes(2);
    fakes[1]!.connected();
    expect(await again).toBe(fakes[1]!.client);
  });

  it("clears a cooldown so the next call connects again straight away", async () => {
    const { getRedis, closeRedis, redisState } = await freshClient();
    const first = getRedis();
    fakes[0]!.refused();
    await first;
    expect(redisState().status).toBe("down");

    await closeRedis();
    expect(redisState().status).toBe("disconnected");
    void getRedis();
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("is safe to call when nothing was ever opened", async () => {
    const { closeRedis } = await freshClient();
    await expect(closeRedis()).resolves.toBeUndefined();
  });

  it("invalidates a connect that is still in flight, so its handle never comes back", async () => {
    // A fire-and-forget counter starts a connect; a test's afterEach closes the
    // module; the connect then lands. Without a generation check the module
    // would hold a live socket the caller was told is gone — opened against
    // whatever REDIS_URL was current before the close.
    const { getRedis, closeRedis, redisState } = await freshClient();
    const first = getRedis();
    expect(redisState().status).toBe("connecting");

    await closeRedis();
    fakes[0]!.connected();
    expect(await first).toBeNull();
    expect(redisState().status).toBe("disconnected");
    expect(fakes[0]!.client.destroyed).toBe(1);

    // The next call opens a fresh handle rather than returning the stale one.
    const again = getRedis();
    expect(createClient).toHaveBeenCalledTimes(2);
    fakes[1]!.connected();
    expect(await again).toBe(fakes[1]!.client);
    expect(fakes[1]!.client).not.toBe(fakes[0]!.client);
  });

  it("does not start a cooldown from a refused connect that was closed while in flight", async () => {
    // The refusal belongs to the URL before the close; the next call must
    // read REDIS_URL afresh and try, not sit out thirty seconds for it.
    const { getRedis, closeRedis, redisState } = await freshClient();
    const first = getRedis();
    await closeRedis();
    fakes[0]!.refused();
    expect(await first).toBeNull();
    expect(redisState().status).toBe("disconnected");
    void getRedis();
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});
