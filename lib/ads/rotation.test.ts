import { describe, expect, it } from "vitest";
import { rotate, rotationSeed } from "./rotation";

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, weight: 1 }));

describe("rotate", () => {
  it("is deterministic for a seed and changes with it", () => {
    const items = ids(12);
    const a = rotate(items, rotationSeed("build-1", "2026-09-22"), 5).map((i) => i.id);
    const b = rotate(items, rotationSeed("build-1", "2026-09-22"), 5).map((i) => i.id);
    expect(a).toEqual(b);
    const nextDay = rotate(items, rotationSeed("build-1", "2026-09-23"), 5).map((i) => i.id);
    const nextBuild = rotate(items, rotationSeed("build-2", "2026-09-22"), 5).map((i) => i.id);
    expect(nextDay).not.toEqual(a);
    expect(nextBuild).not.toEqual(a);
  });

  it("never repeats an item and respects the limit", () => {
    const picked = rotate(ids(20), "s", 5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((i) => i.id)).size).toBe(5);
    expect(rotate(ids(3), "s", 5)).toHaveLength(3);
    expect(rotate(ids(3), "s", 0)).toEqual([]);
    expect(rotate([], "s", 5)).toEqual([]);
  });

  it("does not depend on input order", () => {
    const items = ids(9);
    const forward = rotate(items, "seed", 4).map((i) => i.id);
    const backward = rotate([...items].reverse(), "seed", 4).map((i) => i.id);
    expect(forward).toEqual(backward);
  });

  it("a heavier weight wins more often across many seeds, but never always", () => {
    const items = [{ id: "heavy", weight: 3 }, { id: "light", weight: 1 }];
    let heavyFirst = 0;
    const trials = 400;
    for (let i = 0; i < trials; i++) {
      if (rotate(items, `seed-${i}`, 1)[0]!.id === "heavy") heavyFirst++;
    }
    // expected 3/4; allow a wide band so the test is not flaky on the hash
    expect(heavyFirst / trials).toBeGreaterThan(0.62);
    expect(heavyFirst / trials).toBeLessThan(0.88);
  });

  it("treats a bad weight as 1", () => {
    const items = [{ id: "a", weight: Number.NaN }, { id: "b", weight: 0 }];
    expect(rotate(items, "s", 2)).toHaveLength(2);
  });
});
