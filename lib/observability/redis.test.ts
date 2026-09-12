import { describe, it, expect, vi, beforeEach } from "vitest";
import { probeRedis, type RedisProbeClient } from "./redis";

function client(over: Partial<RedisProbeClient> = {}): RedisProbeClient {
  return { ping: async () => "PONG", destroy: () => undefined, ...over };
}

// `vi.hoisted` because `./redis`'s own static import of `@redis/client` is
// resolved before this file's body runs — a plain module-scope `vi.fn()`
// referenced from the `vi.mock` factory below would not exist yet.
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@redis/client", () => ({ createClient }));

describe("probeRedis", () => {
  it("is absent when REDIS_URL is unset", async () => {
    const connect = vi.fn();

    await expect(probeRedis({}, connect)).resolves.toBe("absent");
    expect(connect).not.toHaveBeenCalled();
  });

  it("is absent when REDIS_URL is blank", async () => {
    await expect(probeRedis({ REDIS_URL: "   " }, vi.fn())).resolves.toBe("absent");
  });

  it("is ok when the server answers PING", async () => {
    const connect = vi.fn(async () => client());

    await expect(probeRedis({ REDIS_URL: "redis://localhost:6380/14" }, connect)).resolves.toBe(
      "ok",
    );
    expect(connect).toHaveBeenCalledWith("redis://localhost:6380/14");
  });

  it("is fail when the connection cannot be made", async () => {
    const connect = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(probeRedis({ REDIS_URL: "redis://nope:1/0" }, connect)).resolves.toBe("fail");
  });

  it("is fail when PING itself rejects", async () => {
    const connect = async () =>
      client({
        ping: async () => {
          throw new Error("LOADING");
        },
      });

    await expect(probeRedis({ REDIS_URL: "redis://localhost:6380/14" }, connect)).resolves.toBe(
      "fail",
    );
  });

  it("closes the connection whether the ping worked or not", async () => {
    // A health check runs every few seconds forever. One leaked socket per
    // probe exhausts Redis's connection limit within a day.
    const destroy = vi.fn();
    const ok = await probeRedis({ REDIS_URL: "redis://x" }, async () => client({ destroy }));
    const bad = await probeRedis({ REDIS_URL: "redis://x" }, async () =>
      client({
        destroy,
        ping: async () => {
          throw new Error("nope");
        },
      }),
    );

    expect([ok, bad]).toEqual(["ok", "fail"]);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("still answers when closing the connection throws", async () => {
    const connect = async () =>
      client({
        destroy: () => {
          throw new Error("already closed");
        },
      });

    await expect(probeRedis({ REDIS_URL: "redis://x" }, connect)).resolves.toBe("ok");
  });
});

describe("the default connect (openClient)", () => {
  // These exercise `probeRedis`'s own default parameter, which is `openClient`
  // — the function every other test above bypasses by injecting its own
  // `connect`. `@redis/client` is mocked (see the top of this file) so a
  // rejecting `connect()` can be handed to `probeRedis` without a real socket.
  beforeEach(() => {
    createClient.mockReset();
  });

  it("destroys the client `createClient` returned when connect() itself throws", async () => {
    // Without this, a client whose `connect()` fails is never destroyed:
    // `probeRedis`'s own `finally` only runs `destroy()` on whatever `connect`
    // successfully RETURNS, and a rejected promise returns nothing — the
    // socket `createClient` opened would stay open until GC gets to it.
    const destroy = vi.fn();
    createClient.mockReturnValue({
      on: vi.fn(),
      connect: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      destroy,
    });

    await expect(probeRedis({ REDIS_URL: "redis://localhost:6380/14" })).resolves.toBe("fail");

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("still answers fail when destroying that same client also throws", async () => {
    createClient.mockReturnValue({
      on: vi.fn(),
      connect: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      destroy: () => {
        throw new Error("already closed");
      },
    });

    await expect(probeRedis({ REDIS_URL: "redis://localhost:6380/14" })).resolves.toBe("fail");
  });
});
