import { describe, expect, it } from "vitest";
import { excludeFeatured, pageRows } from "./grid";

describe("excludeFeatured", () => {
  it("removes exactly the featured ids from the organic rows, keeping order", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(excludeFeatured(rows, [{ id: "c" }, { id: "a" }])).toEqual([{ id: "b" }, { id: "d" }]);
  });

  it("is a copy of the rows when nothing is featured", () => {
    const rows = [{ id: "a" }];
    const out = excludeFeatured(rows, []);
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  it("ignores a featured listing that is not in the rows (it is on a later page)", () => {
    expect(excludeFeatured([{ id: "a" }], [{ id: "zzz" }])).toEqual([{ id: "a" }]);
  });
});

describe("pageRows", () => {
  const rows = [
    { id: "p1", tier: "premium" as const },
    { id: "f1", tier: "premium" as const },
    { id: "e1", tier: "essential" as const },
    { id: "p2", tier: "premium" as const },
  ];

  it("shows the premium row only when no bid holds a position — one Featured section per page", () => {
    expect(pageRows(rows, [{ id: "f1" }], true).premium).toEqual([]);
    expect(pageRows(rows, [], true).premium.map((r) => r.id)).toEqual(["p1", "f1", "p2"]);
    expect(pageRows(rows, [], false).premium).toEqual([]);
  });

  it("builds the premium row from the grid, so a premium listing with a bid is never on the page twice", () => {
    const { grid, premium } = pageRows(rows, [{ id: "f1" }], true);
    expect(grid.map((r) => r.id)).toEqual(["p1", "e1", "p2"]);
    const all = [...grid, ...premium, { id: "f1" }].map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
  });
});
