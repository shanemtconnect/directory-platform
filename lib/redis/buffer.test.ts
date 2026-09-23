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
    expect(buffer.take()).toEqual([{ key: "a", count: 1, expireSeconds: 60, attempts: 0 }]);
  });

  it("take() hands everything over once and leaves the buffer empty", () => {
    const buffer = new CounterBuffer("test");
    buffer.add("a", 2);
    buffer.add("b");
    expect(buffer.take()).toEqual([
      { key: "a", count: 2, expireSeconds: null, attempts: 0 },
      { key: "b", count: 1, expireSeconds: null, attempts: 0 },
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
      { key: "a", count: 2, expireSeconds: null, attempts: 0 },
      { key: "b", count: 1, expireSeconds: null, attempts: 0 },
    ]);
  });

  it("logs the overflow once per outage, not once per dropped key", async () => {
    const warn = vi.fn();
    const buffer = new CounterBuffer("badge", 2, warn);
    for (let i = 0; i < 10; i++) buffer.add(`k${i}`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("[badge]");

    // A flush that lands ends the outage; the next overflow is a new one and
    // is logged again.
    await buffer.flush(async () => {});
    for (let i = 0; i < 10; i++) buffer.add(`k${i}`);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not log the overflow again after a flush that put everything back", async () => {
    // A flapping Redis fails flush after flush; that is one outage, one line.
    const warn = vi.fn();
    const buffer = new CounterBuffer("badge", 2, warn);
    for (let i = 0; i < 4; i++) buffer.add(`k${i}`);
    expect(warn).toHaveBeenCalledTimes(1);
    await buffer.flush(async () => {
      throw new Error("connection reset");
    });
    for (let i = 0; i < 4; i++) buffer.add(`j${i}`);
    expect(warn).toHaveBeenCalledTimes(1);
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
        { key: "a", count: 3, expireSeconds: null, attempts: 0 },
        { key: "b", count: 1, expireSeconds: 60, attempts: 0 },
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
      expect(buffer.take()).toEqual([{ key: "broken", count: 4, expireSeconds: 60, attempts: 1 }]);
    });

    it("gives up on an entry whose replay has failed twice, so a flapping socket cannot double-count for ever", async () => {
      // Each replay is at-least-once: the INCRBY may have landed before the
      // reply was lost. Two tries bounds that at one possible extra count per
      // key per outage; after that the entry is dropped, which is the old
      // behaviour for a count that could not reach Redis.
      const buffer = new CounterBuffer("test");
      const fail = async () => {
        throw new Error("connection reset");
      };
      buffer.add("a", 2);
      await buffer.flush(fail);
      expect(buffer.size).toBe(1);
      await buffer.flush(fail);
      expect(buffer.size).toBe(0);
      expect(buffer.abandoned).toBe(1);
      expect(buffer.take()).toEqual([]);
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
      expect(buffer.take()).toEqual([{ key: "a", count: 3, expireSeconds: null, attempts: 1 }]);
    });

    it("counts a fresh hit merged into a put-back entry towards that entry's attempts", async () => {
      // The merged entry carries the higher attempt count: a key that has
      // failed twice is dropped whole, fresh hit included. Bounded loss, not
      // unbounded retry — the fresh hit's own first attempt happens with the
      // replay that fails a second time.
      const buffer = new CounterBuffer("test");
      const fail = async () => {
        throw new Error("connection reset");
      };
      buffer.add("a");
      await buffer.flush(fail);
      buffer.add("a");
      expect(buffer.take()).toEqual([{ key: "a", count: 2, expireSeconds: null, attempts: 1 }]);
    });
  });
});
