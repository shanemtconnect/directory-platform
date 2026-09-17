import { describe, expect, it } from "vitest";
import { SPARKLINE_BOX, sparkline } from "./sparkline";

const box = SPARKLINE_BOX;

function coords(points: string): [number, number][] {
  return points.split(" ").map((p) => {
    const [x, y] = p.split(",").map(Number);
    return [x!, y!];
  });
}

describe("sparkline", () => {
  it("returns null for an empty series — there is no line to draw", () => {
    expect(sparkline([])).toBeNull();
  });

  it("draws a flat line along the baseline when nothing happened", () => {
    const s = sparkline([0, 0, 0, 0])!;
    const ys = coords(s.points).map(([, y]) => y);

    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBe(box.height - box.padding);
    expect(s.max).toBe(0);
  });

  it("puts the largest day at the top and the smallest at the bottom", () => {
    const s = sparkline([0, 5, 10])!;
    const ys = coords(s.points).map(([, y]) => y);

    expect(ys[2]).toBe(box.padding);
    expect(ys[0]).toBe(box.height - box.padding);
    expect(ys[1]).toBeGreaterThan(ys[2]!);
    expect(ys[1]).toBeLessThan(ys[0]!);
    expect(s.max).toBe(10);
  });

  it("spreads the points evenly across the full width", () => {
    const xs = coords(sparkline([1, 2, 3, 4, 5])!.points).map(([x]) => x);

    expect(xs[0]).toBe(box.padding);
    expect(xs.at(-1)).toBe(box.width - box.padding);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 6);
  });

  it("centres a single day rather than dividing by zero", () => {
    const s = sparkline([7])!;
    const [[x]] = coords(s.points) as [[number, number]];

    expect(x).toBe(box.width / 2);
    expect(Number.isFinite(x)).toBe(true);
  });

  it("stays inside the viewBox for every input", () => {
    for (const series of [[0, 1], [1000000, 0, 3], [2, 2, 2], [0, 0, 1]]) {
      for (const [x, y] of coords(sparkline(series)!.points)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(box.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(box.height);
      }
    }
  });

  it("ignores negative and non-finite values instead of drawing off-canvas", () => {
    const s = sparkline([-5, Number.NaN, 10])!;
    for (const [, y] of coords(s.points)) {
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeLessThanOrEqual(box.height);
    }
    expect(s.max).toBe(10);
  });

  it("emits coordinates rounded enough to keep the markup small", () => {
    for (const p of sparkline([1, 7, 3, 9])!.points.split(" ")) {
      expect(p).toMatch(/^\d+(\.\d)?,\d+(\.\d)?$/);
    }
  });
});
