import { beforeEach, describe, expect, it, vi } from "vitest";
import { elements } from "@/test/elements";

/**
 * The "Verified only" checkbox: gated on a count (never a full `search()`
 * call — see searchCount's own doc), preserved through pagination via
 * `basePath`, and its `defaultChecked` follows the URL, not client state.
 */

vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));

const search = vi.fn();
const searchCount = vi.fn();
vi.mock("@/lib/db/queries/search", () => ({
  search: (...a: unknown[]) => search(...a),
  searchCount: (...a: unknown[]) => searchCount(...a),
}));
vi.mock("@/lib/db/queries/indexes", () => ({
  listCities: () => Promise.resolve([]),
  listCategories: () => Promise.resolve([]),
}));
vi.mock("@/lib/db/queries/cities", () => ({
  listSwitcherCities: () => Promise.resolve([]),
}));

const EMPTY_RESULT = { rows: [], total: 0, page: 1, totalPages: 1 };

function sp(query: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(query) };
}

function checkbox(node: unknown) {
  return [...elements(node as never)].find(
    (el) => el.type === "input" && (el.props as Record<string, unknown>).name === "verified",
  );
}

async function findPagination(node: unknown) {
  const { Pagination } = await import("@/components/pillar/Pagination");
  const found = [...elements(node as never)].find((el) => el.type === Pagination);
  return found?.props as { basePath: string } | undefined;
}

beforeEach(() => {
  vi.resetModules();
  search.mockReset().mockResolvedValue(EMPTY_RESULT);
  searchCount.mockReset().mockResolvedValue(0);
});

describe("/search verified checkbox", () => {
  it("is absent when nothing verified matches the current filters — never offers a filter that would empty the grid", async () => {
    searchCount.mockResolvedValue(0);
    const { default: SearchPage } = await import("./page");
    const el = await SearchPage(sp());
    expect(checkbox(el)).toBeUndefined();
    // Gated on a COUNT, not a full search() — only one search() call (the
    // page's own results), never a second one just to size the toggle.
    expect(search).toHaveBeenCalledTimes(1);
    expect(searchCount).toHaveBeenCalledTimes(1);
  });

  it("is present and unchecked when something verified matches and the filter is off", async () => {
    searchCount.mockResolvedValue(3);
    const { default: SearchPage } = await import("./page");
    const el = await SearchPage(sp());
    const box = checkbox(el);
    expect(box).toBeTruthy();
    expect((box!.props as Record<string, unknown>).defaultChecked).toBe(false);
  });

  it("is present and checked when ?verified=1, and searchCount is not run again (the results themselves already prove it has matches)", async () => {
    search.mockResolvedValue({ ...EMPTY_RESULT, total: 1 });
    const { default: SearchPage } = await import("./page");
    const el = await SearchPage(sp({ verified: "1" }));
    const box = checkbox(el);
    expect(box).toBeTruthy();
    expect((box!.props as Record<string, unknown>).defaultChecked).toBe(true);
    expect(searchCount).not.toHaveBeenCalled();
  });

  it("keeps verified=1 in the pagination base path", async () => {
    search.mockResolvedValue({ ...EMPTY_RESULT, total: 1, totalPages: 2 });
    const { default: SearchPage } = await import("./page");
    const el = await SearchPage(sp({ verified: "1", q: "barn" }));
    const pagination = await findPagination(el);
    expect(pagination?.basePath).toContain("verified=1");
    expect(pagination?.basePath).toContain("q=barn");
  });
});
