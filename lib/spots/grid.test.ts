import { describe, expect, it } from "vitest";
import { excludeFeatured } from "./grid";

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
