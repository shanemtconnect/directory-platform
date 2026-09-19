import { createClient, type RedisClientType } from "@redis/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Real Redis, database 7 (this worktree's, per the wave plan) — same reasoning
 * as `counters.test.ts`: `takeAll`'s whole job is how it behaves when GETDEL
 * itself misbehaves, which a fake client cannot be trusted to reproduce.
 */
process.env.REDIS_URL = "redis://localhost:6380/7";

const { closeStatsRedis, statsRedis } = await import("./redis");

async function flush(): Promise<void> {
  const c = await statsRedis();
  if (!c) throw new Error("redis db 7 is not reachable — start docker compose");
  await c.flushDb();
}

beforeEach(flush);
afterAll(async () => {
  await flush();
  await closeStatsRedis();
});

describe("takeAll", () => {
  it("GETDELs every key and returns the ones that held a positive count", async () => {
    const c = await statsRedis();
    await c!.set("stats:a", "3");
    await c!.set("stats:b", "0");
    await c!.set("stats:c", "not-a-number");

    const out = await c!.takeAll(["stats:a", "stats:b", "stats:c", "stats:missing"]);

    expect(out).toEqual(new Map([["stats:a", 3]]));
  });

  it("keeps the counts already drained when one GETDEL in the batch rejects", async () => {
    // `getDel` on a key of the wrong Redis type rejects with WRONGTYPE — the
    // real-world case this stands in for is a key the drain's own filters
    // should have excluded reaching GETDEL anyway. `Promise.all` would let
    // that one rejection throw away the two keys either side of it in the
    // batch, even though GETDEL already deleted them from Redis by the time
    // the promise settles. `Promise.allSettled` must not.
    const c = await statsRedis();
    await c!.set("stats:a", "5");
    await c!.set("stats:b", "7");

    // No method on StatsRedisClient writes a non-string value — deliberately,
    // per the interface's own comment — so this uses a raw client for the one
    // write that has to hold a list.
    const raw: RedisClientType = createClient({ url: "redis://localhost:6380/7" }) as RedisClientType;
    raw.on("error", () => {});
    await raw.connect();
    await raw.lPush("stats:wrong-type", "x");
    await raw.quit();

    const out = await c!.takeAll(["stats:a", "stats:wrong-type", "stats:b"]);

    expect(out).toEqual(
      new Map([
        ["stats:a", 5],
        ["stats:b", 7],
      ]),
    );
  });
});
