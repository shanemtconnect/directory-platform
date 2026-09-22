import { describe, expect, it } from "vitest";
import { jobsBoardPath, parseJobsPath } from "./routes";

const ID = "6f1c1e6e-2f2b-4d7d-9b1a-3c4d5e6f7a8b";

describe("parseJobsPath", () => {
  it("reads the board, its pages and its filters", () => {
    expect(parseJobsPath([])).toEqual({ kind: "board", citySlug: null, categorySlug: null, page: 1 });
    expect(parseJobsPath(["page", "3"])).toEqual({ kind: "board", citySlug: null, categorySlug: null, page: 3 });
    expect(parseJobsPath(["in", "leeds"])).toEqual({ kind: "board", citySlug: "leeds", categorySlug: null, page: 1 });
    expect(parseJobsPath(["in", "leeds", "barn-venues", "page", "2"]))
      .toEqual({ kind: "board", citySlug: "leeds", categorySlug: "barn-venues", page: 2 });
    expect(parseJobsPath(["category", "barn-venues"]))
      .toEqual({ kind: "board", citySlug: null, categorySlug: "barn-venues", page: 1 });
  });

  it("reads one job by uuid and nothing else as a job", () => {
    expect(parseJobsPath([ID])).toEqual({ kind: "job", id: ID });
    expect(parseJobsPath(["not-a-job"])).toEqual({ kind: "not-found" });
    expect(parseJobsPath([ID, "page", "2"])).toEqual({ kind: "not-found" });
    expect(parseJobsPath([ID, "extra"])).toEqual({ kind: "not-found" });
  });

  it("301s the non-canonical spellings: uppercase and /page/1", () => {
    expect(parseJobsPath(["In", "Leeds"])).toEqual({ kind: "redirect", to: "/jobs/in/leeds" });
    expect(parseJobsPath([ID.toUpperCase()])).toEqual({ kind: "redirect", to: `/jobs/${ID}` });
    expect(parseJobsPath(["page", "1"])).toEqual({ kind: "redirect", to: "/jobs" });
    expect(parseJobsPath(["in", "leeds", "page", "1"])).toEqual({ kind: "redirect", to: "/jobs/in/leeds" });
  });

  it("404s a page number in any other spelling, or past the bound, or with nothing under it", () => {
    for (const raw of ["0", "01", "1.5", "2e1", "-1", "abc", "99999999"]) {
      expect(parseJobsPath(["page", raw]), raw).toEqual({ kind: "not-found" });
    }
    expect(parseJobsPath(["in"])).toEqual({ kind: "not-found" });
    expect(parseJobsPath(["category"])).toEqual({ kind: "not-found" });
    expect(parseJobsPath(["category", "a", "b"])).toEqual({ kind: "not-found" });
    expect(parseJobsPath(["in", "a", "b", "c"])).toEqual({ kind: "not-found" });
    expect(parseJobsPath(["page"])).toEqual({ kind: "not-found" });
  });
});

describe("jobsBoardPath", () => {
  it("builds the canonical URL parseJobsPath reads back", () => {
    const cases: [{ citySlug?: string; categorySlug?: string }, number][] = [
      [{}, 1],
      [{}, 4],
      [{ citySlug: "leeds" }, 1],
      [{ citySlug: "leeds", categorySlug: "barn-venues" }, 2],
      [{ categorySlug: "barn-venues" }, 3],
    ];
    for (const [filters, page] of cases) {
      const path = jobsBoardPath(filters, page);
      const parsed = parseJobsPath(path.replace(/^\/jobs\/?/, "").split("/").filter(Boolean));
      expect(parsed).toEqual({
        kind: "board",
        citySlug: filters.citySlug ?? null,
        categorySlug: filters.categorySlug ?? null,
        page,
      });
    }
    expect(jobsBoardPath()).toBe("/jobs");
    expect(jobsBoardPath({ citySlug: "leeds" }, 2)).toBe("/jobs/in/leeds/page/2");
  });
});
