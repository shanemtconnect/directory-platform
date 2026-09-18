import { describe, it, expect, vi } from "vitest";
import { CounterBuffer, COUNTER_BUFFER_MAX_KEYS } from "./buffer";

describe("CounterBuffer", () => {
  it("adds up increments per key and reports the running count", () => {
    const buffer = new CounterBuffer("test");
    expect(buffer.add("a")).toBe(1);
    expect(buffer.add("a")).toBe(2);
    expect(buffer.add("b", 5)).toBe(5);
    expect(buffer.size).toBe(2);
  });

  it("remembers a TTL for a key it holds, and ignores one for a key it does not", () => {
    const buffer = new CounterBuffer("test");
    buffer.add("a");
    buffer.expire("a", 60);
    buffer.expire("missing", 60);
    expect(buffer.take()).toEqual([{ key: "a", count: 1, expireSeconds: 60 }]);
  });

  it("take() hands everything over once and leaves the buffer empty", () => {
    const buffer = new CounterBuffer("test");
    buffer.add("a", 2);
    buffer.add("b");
    expect(buffer.take()).toEqual([
      { key: "a", count: 2, expireSeconds: null },
      { key: "b", count: 1, expireSeconds: null },
    ]);
    expect(buffer.size).toBe(0);
    expect(buffer.take()).toEqual([]);
  });

  it("drops the oldest key once full, so an outage cannot grow memory without bound", () => {
    const warn = vi.fn();
    const buffer = new CounterBuffer("test", 3, warn);
    buffer.add("oldest");
    buffer.add("b");
    buffer.add("c");
    buffer.add("d");
    expect(buffer.size).toBe(3);
    expect(buffer.take().map((e) => e.key)).toEqual(["b", "c", "d"]);
    expect(buffer.dropped).toBe(1);
  });

  it("bumping a key it already holds never evicts anything", () => {
    const buffer = new CounterBuffer("test", 2);
    buffer.add("a");
    buffer.add("b");
    buffer.add("a");
    expect(buffer.dropped).toBe(0);
    expect(buffer.take()).toEqual([
      { key: "a", count: 2, expireSeconds: null },
      { key: "b", count: 1, expireSeconds: null },
    ]);
  });

  it("logs the overflow once per outage, not once per dropped key", () => {
    const warn = vi.fn();
    const buffer = new CounterBuffer("badge", 2, warn);
    for (let i = 0; i < 10; i++) buffer.add(`k${i}`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("[badge]");

    // A flush ends the outage; the next overflow is a new one and is logged again.
    buffer.take();
    for (let i = 0; i < 10; i++) buffer.add(`k${i}`);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("defaults to a cap in the region of ten thousand keys", () => {
    expect(COUNTER_BUFFER_MAX_KEYS).toBe(10_000);
  });

  describe("flush", () => {
    it("applies every pending increment and empties the buffer", async () => {
      const buffer = new CounterBuffer("test");
      buffer.add("a", 3);
      buffer.add("b");
      buffer.expire("b", 60);
      const applied: unknown[] = [];
      await buffer.flush(async (entry) => {
        applied.push(entry);
      });
      expect(applied).toEqual([
        { key: "a", count: 3, expireSeconds: null },
        { key: "b", count: 1, expireSeconds: 60 },
      ]);
      expect(buffer.size).toBe(0);
    });

    it("puts back what failed to apply, TTL included, and keeps what succeeded out", async () => {
      // Redis going away mid-flush must not lose the counts that had not
      // landed yet: they go back in the buffer for the next attempt.
      const buffer = new CounterBuffer("test");
      buffer.add("ok", 2);
      buffer.add("broken", 4);
      buffer.expire("broken", 60);
      await buffer.flush(async (entry) => {
        if (entry.key === "broken") throw new Error("connection reset");
      });
      expect(buffer.take()).toEqual([{ key: "broken", count: 4, expireSeconds: 60 }]);
    });

    it("never rejects, whatever the apply function does", async () => {
      const buffer = new CounterBuffer("test");
      buffer.add("a");
      await expect(
        buffer.flush(async () => {
          throw new Error("boom");
        }),
      ).resolves.toBeUndefined();
    });

    it("merges a count that arrives during the flush with one put back after a failure", async () => {
      const buffer = new CounterBuffer("test");
      buffer.add("a", 2);
      await buffer.flush(async () => {
        // A hit lands while the flush is in progress ...
        buffer.add("a");
        // ... and then the flush of the original two fails.
        throw new Error("connection reset");
      });
      expect(buffer.take()).toEqual([{ key: "a", count: 3, expireSeconds: null }]);
    });
  });
});
