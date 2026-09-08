import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, type RedisClientType } from "@redis/client";
import { randomUUID } from "node:crypto";
import {
  sweepStaleNamespaces,
  sweepDelayMs,
  DEFAULT_SWEEP_DELAY_MS,
} from "@/lib/cache/sweep.mjs";

// db 7, never db 0: :6380 is the shared dev Redis. Every key this file writes
// lives under a namespace of its own, so the sweep it exercises is real but
// cannot reach `nextjs:` or anyone else's data.
const URL = process.env.SWEEP_TEST_REDIS_URL ?? "redis://localhost:6380/7";

let client: RedisClientType;
let ns: string;
const prefix = (buildId: string) => `${ns}:${buildId}:`;

beforeAll(async () => {
  client = createClient({ url: URL }) as RedisClientType;
  client.on("error", () => {});
  await client.connect();
});

afterAll(async () => {
  if (client?.isReady) await client.quit();
});

beforeEach(async () => {
  ns = `vitest-sweep-${randomUUID()}`;
});

async function seed(keys: string[]) {
  await Promise.all(keys.map((k) => client.set(k, "x")));
}

async function keysUnder(pattern: string) {
  const found: string[] = [];
  for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 500 })) {
    found.push(...(Array.isArray(key) ? key : [key]));
  }
  return found.sort();
}

describe("sweepStaleNamespaces", () => {
  it("deletes every other build's keys and keeps the running build's", async () => {
    const current = prefix("current");
    await seed([
      `${current}/index`,
      `${current}__sharedTags__`,
      `${prefix("older")}/index`,
      `${prefix("older")}__sharedTags__`,
      `${prefix("oldest")}/cities/london`,
    ]);

    expect(await sweepStaleNamespaces(client, current)).toBe(3);
    expect(await keysUnder(`${ns}:*`)).toEqual([`${current}/index`, `${current}__sharedTags__`]);
  });

  it("deletes the un-namespaced keys the old handler wrote", async () => {
    const current = prefix("current");
    await seed([`${ns}:/index`, `${ns}:__sharedTags__`, `${current}/index`]);

    expect(await sweepStaleNamespaces(client, current)).toBe(2);
    expect(await keysUnder(`${ns}:*`)).toEqual([`${current}/index`]);
  });

  it("leaves other namespaces alone", async () => {
    const current = prefix("current");
    const foreign = `vitest-other-${randomUUID()}:keep-me`;
    await seed([foreign, `${prefix("older")}/index`]);

    expect(await sweepStaleNamespaces(client, current)).toBe(1);
    expect(await client.exists(foreign)).toBe(1);
    await client.del(foreign);
  });

  it("is idempotent — a second sweep finds nothing", async () => {
    const current = prefix("current");
    await seed([`${prefix("older")}/index`, `${current}/index`]);

    expect(await sweepStaleNamespaces(client, current)).toBe(1);
    expect(await sweepStaleNamespaces(client, current)).toBe(0);
  });

  it("sweeps more keys than one SCAN page or one DEL batch holds", async () => {
    // SCAN returns a page at a time and may repeat keys across pages; the loop
    // has to keep going and must not double-count what it already deleted.
    const current = prefix("current");
    const stale = Array.from({ length: 300 }, (_, i) => `${prefix("older")}/p/${i}`);
    await seed([...stale, `${current}/index`]);

    expect(await sweepStaleNamespaces(client, current, { batchSize: 32, scanCount: 11 })).toBe(300);
    expect(await keysUnder(`${ns}:*`)).toEqual([`${current}/index`]);
  });

  it("refuses a malformed prefix instead of guessing a pattern", async () => {
    await seed([`${prefix("older")}/index`]);
    await expect(sweepStaleNamespaces(client, `${ns}:`)).rejects.toThrow(/prefix/i);
    // Nothing was deleted on the way to throwing.
    expect(await keysUnder(`${ns}:*`)).toEqual([`${prefix("older")}/index`]);
  });
});

describe("sweepDelayMs", () => {
  it("defaults to a minute, long enough for a rolling deploy to finish the swap", () => {
    expect(DEFAULT_SWEEP_DELAY_MS).toBe(60_000);
    expect(sweepDelayMs(undefined)).toBe(DEFAULT_SWEEP_DELAY_MS);
    expect(sweepDelayMs("")).toBe(DEFAULT_SWEEP_DELAY_MS);
    expect(sweepDelayMs("  ")).toBe(DEFAULT_SWEEP_DELAY_MS);
  });

  it("takes a whole number of milliseconds, zero included", () => {
    expect(sweepDelayMs("0")).toBe(0);
    expect(sweepDelayMs("5000")).toBe(5000);
    expect(sweepDelayMs(" 5000 ")).toBe(5000);
  });

  it("falls back to the default rather than scheduling on nonsense", () => {
    for (const bad of ["-1", "abc", "1.5", "1e999", "Infinity", "NaN", null, {}]) {
      expect(sweepDelayMs(bad as unknown as string)).toBe(DEFAULT_SWEEP_DELAY_MS);
    }
  });
});
