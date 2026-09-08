import { describe, it, expect } from "vitest";
import { pageWindow } from "./page-window";

describe("pageWindow", () => {
  it("lists every page when they all fit", () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the first and the last page reachable from the middle", () => {
    const w = pageWindow(50, 100);
    expect(w[0]).toBe(1);
    expect(w.at(-1)).toBe(100);
  });

  it("shows two pages either side of the current one", () => {
    expect(pageWindow(50, 100)).toEqual([1, "gap", 48, 49, 50, 51, 52, "gap", 100]);
  });

  it("marks a gap on one side only when the window touches an end", () => {
    expect(pageWindow(2, 100)).toEqual([1, 2, 3, 4, "gap", 100]);
    expect(pageWindow(99, 100)).toEqual([1, "gap", 97, 98, 99, 100]);
  });

  it("renders the single missing page rather than an ellipsis standing for it", () => {
    // Left of the window only page 2 is missing, so it is rendered; right of it
    // 8 and 9 both are, so that side gets the ellipsis. An ellipsis hiding
    // exactly one page is a worse link than the page, and costs the same width.
    expect(pageWindow(5, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, "gap", 10]);
  });

  it("never repeats a page and always ascends", () => {
    for (const total of [1, 2, 6, 7, 8, 40]) {
      for (let page = 1; page <= total; page++) {
        const numbers = pageWindow(page, total).filter((n): n is number => n !== "gap");
        expect(new Set(numbers).size).toBe(numbers.length);
        expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
        expect(numbers).toContain(page);
      }
    }
  });

  it("stays a bounded length however many pages there are", () => {
    // first + gap + five + gap + last
    expect(pageWindow(500, 1000)).toHaveLength(9);
  });

  it("returns nothing to paginate for a single page", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 0)).toEqual([]);
  });
});
