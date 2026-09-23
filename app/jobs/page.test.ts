import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Flag off = a real 404 on every public board route, with no query run, and
 * no nav, footer or sitemap entry. The pages read `features` at render (not
 * at import), so the flag is flipped per test through the mock's getter.
 */

class NotFound extends Error {}

let flagOn = false;
const listOpenJobs = vi.fn();
const getPublicJob = vi.fn();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { jobBoard: flagOn };
  },
}));
vi.mock("@/lib/db/queries/job-board", () => ({
  JOBS_PER_PAGE: 20,
  listOpenJobs: () => listOpenJobs(),
  countOpenJobs: () => Promise.resolve(0),
  jobFilterOptions: () => Promise.resolve({ cities: [], categories: [] }),
  resolveJobFilters: () => Promise.resolve({ city: null, category: null }),
  getPublicJob: () => getPublicJob(),
}));

beforeEach(() => {
  vi.resetModules();
  flagOn = false;
  listOpenJobs.mockReset().mockResolvedValue([]);
  getPublicJob.mockReset().mockResolvedValue(null);
});

describe("jobBoard off", () => {
  it("/jobs is a 404 and runs no query", async () => {
    const { default: page } = await import("./page");
    await expect(page()).rejects.toThrow(NotFound);
    expect(listOpenJobs).not.toHaveBeenCalled();
  });

  it("every catch-all spelling is a 404 too", async () => {
    const { default: page } = await import("./[...segments]/page");
    for (const segments of [["page", "2"], ["in", "leeds"], ["6f1c1e6e-2f2b-4d7d-9b1a-3c4d5e6f7a8b"]]) {
      await expect(page({ params: Promise.resolve({ segments }) })).rejects.toThrow(NotFound);
    }
    expect(getPublicJob).not.toHaveBeenCalled();
    expect(listOpenJobs).not.toHaveBeenCalled();
  });

  it("the posting and admin pages are 404s as well", async () => {
    const post = await import("../post-a-job/page");
    await expect(post.default()).rejects.toThrow(NotFound);
    const thanks = await import("../post-a-job/thanks/page");
    expect(() => thanks.default()).toThrow(NotFound);
  });

  it("advertises nothing: no nav, footer or sitemap entry", async () => {
    const { buildRoutes } = await import("@/lib/features/navigation");
    const { FEATURE_FLAGS } = await import("@/config/types");
    const off = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<string, boolean>;
    const hrefs = buildRoutes(off as never, "niche-national").map((r) => r.href);
    expect(hrefs).not.toContain("/jobs");
    expect(hrefs).not.toContain("/post-a-job");
  });
});

describe("jobBoard on", () => {
  it("renders the board", async () => {
    flagOn = true;
    const { default: page } = await import("./page");
    await expect(page()).resolves.toBeTruthy();
    expect(listOpenJobs).toHaveBeenCalledTimes(1);
  });

  it("advertises the board and the posting page", async () => {
    const { buildRoutes } = await import("@/lib/features/navigation");
    const { FEATURE_FLAGS } = await import("@/config/types");
    const on = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, true])) as Record<string, boolean>;
    const routes = buildRoutes(on as never, "niche-national");
    expect(routes.find((r) => r.href === "/jobs")).toMatchObject({ inNav: true, inFooter: true, inSitemap: true });
    expect(routes.find((r) => r.href === "/post-a-job")).toMatchObject({ inSitemap: true });
  });
});
