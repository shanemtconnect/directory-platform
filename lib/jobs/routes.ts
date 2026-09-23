import { MAX_PAGE_NUMBER } from "@/lib/routing/resolve";

/**
 * The jobs board's URL grammar, as a pure function (Task 49).
 *
 *   /jobs                                   the board
 *   /jobs/page/N                            page N of it
 *   /jobs/in/<city>[/<category>][/page/N]   filtered by town (and category)
 *   /jobs/category/<category>[/page/N]      filtered by category
 *   /jobs/<uuid>                            one job
 *
 * Path-based on purpose, like every other paginated page on the site:
 * reading `searchParams` makes a route dynamic in Next 16 and would keep the
 * board out of the ISR cache (global constraint 12). The same three
 * canonicalisation rules as lib/routing/resolve.ts apply — lowercase is the
 * only spelling, `/page/1` is the bare URL, and a page number above the
 * bound is not a URL at all — so the board cannot mint duplicate content
 * under a second spelling.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE_NUMBER = /^[1-9]\d*$/;

/** Where a finished post lands. Lives here because a "use server" module may export only async functions. */
export const JOB_THANKS_PATH = "/post-a-job/thanks";

export type JobsRoute =
  | { kind: "board"; citySlug: string | null; categorySlug: string | null; page: number }
  | { kind: "job"; id: string }
  /** A non-canonical spelling of a real page: 301 there. */
  | { kind: "redirect"; to: string }
  | { kind: "not-found" };

/** The canonical URL for a board page. Page 1 is the bare path. */
export function jobsBoardPath(
  filters: { citySlug?: string | null; categorySlug?: string | null } = {},
  page = 1,
): string {
  let path = "/jobs";
  if (filters.citySlug) {
    path += `/in/${filters.citySlug}`;
    if (filters.categorySlug) path += `/${filters.categorySlug}`;
  } else if (filters.categorySlug) {
    path += `/category/${filters.categorySlug}`;
  }
  return page > 1 ? `${path}/page/${page}` : path;
}

export function parseJobsPath(segments: readonly string[]): JobsRoute {
  const lowered = segments.map((s) => s.toLowerCase());
  if (lowered.some((s, i) => s !== segments[i])) {
    return { kind: "redirect", to: `/jobs/${lowered.join("/")}` };
  }

  // Pagination suffix, exactly one spelling.
  let page = 1;
  let rest = lowered;
  if (rest.length >= 2 && rest[rest.length - 2] === "page") {
    const raw = rest[rest.length - 1] ?? "";
    if (!PAGE_NUMBER.test(raw)) return { kind: "not-found" };
    page = Number(raw);
    if (page > MAX_PAGE_NUMBER) return { kind: "not-found" };
    rest = rest.slice(0, -2);
    if (page === 1) return { kind: "redirect", to: `/jobs${rest.length ? `/${rest.join("/")}` : ""}` };
  }

  const [head, a, b, ...tail] = rest;
  if (head === undefined) return { kind: "board", citySlug: null, categorySlug: null, page };

  if (tail.length > 0) return { kind: "not-found" };

  if (head === "in" && a !== undefined) {
    return { kind: "board", citySlug: a, categorySlug: b ?? null, page };
  }
  if (head === "category" && a !== undefined && b === undefined) {
    return { kind: "board", citySlug: null, categorySlug: a, page };
  }
  if (a === undefined && page === 1 && UUID.test(head)) return { kind: "job", id: head };

  return { kind: "not-found" };
}
