import { describe, it, expect, vi } from "vitest";
import { probeRedis, type RedisProbeClient } from "./redis";

function client(over: Partial<RedisProbeClient> = {}): RedisProbeClient {
  return { ping: async () => "PONG", destroy: () => undefined, ...over };
}

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
