import { pageWindow } from "./page-window";

interface Props {
  basePath: string;
  page: number;
  totalPages: number;
  /**
   * Search keeps its filters in the query string, so its pagination must too.
   * Pillar pages use path pagination (/city/page/2) because reading
   * searchParams on the MAIN route would force it dynamic and kill its ISR
   * cache — search is already dynamic and noindexed, so the trade-off does
   * not apply there. `verified` (below) is the one pillar filter that IS a
   * query param, and it only works because /verified/[...segments] is a
   * second, separate, genuinely-dynamic route reached via a next.config.ts
   * rewrite — the ISR route itself still never reads searchParams.
   */
  searchStyle?: boolean;
  /**
   * Pillar pages: append `verified=1` to every page link so paging through a
   * filtered grid keeps the filter on. Search already carries it as part of
   * `basePath` (it keeps every filter in the query string), so this is a
   * no-op there — never pass both.
   */
  verified?: boolean;
}

/* Split so the current page can swap the background without two `bg-*`
   utilities fighting: Tailwind orders those by its own sort, not by the order
   they appear in the class attribute, so the loser is not the one you expect. */
const SLOT =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-token)] border px-3 no-underline";
const LINK = `${SLOT} border-line bg-surface hover:border-primary`;
const CURRENT = `${SLOT} border-primary bg-primary font-semibold text-on-primary`;

/**
 * Every paginated link is a real <a href> to a real, server-rendered URL.
 * GeoDirectory's demo uses javascript:void(0) and pages 2+ of every category
 * are effectively invisible to crawlers. There is a CI test asserting this.
 *
 * The numbers are windowed by `pageWindow` rather than listed 1..N: a city with
 * four hundred pages would otherwise put four hundred links on each of its four
 * hundred paginated URLs. First, last and the current page's neighbours are all
 * that a reader or a crawler needs, and prev/next carry rel so the sequence is
 * still declared.
 */
export function Pagination({ basePath, page, totalPages, searchStyle = false, verified = false }: Props) {
  if (totalPages <= 1) return null;
  const withVerified = (h: string) => (verified ? `${h}${h.includes("?") ? "&" : "?"}verified=1` : h);
  const href = (n: number) => {
    if (n === 1) return withVerified(basePath);
    if (searchStyle) {
      return withVerified(basePath.includes("?") ? `${basePath}&page=${n}` : `${basePath}?page=${n}`);
    }
    return withVerified(`${basePath}/page/${n}`);
  };
  // Every page of the verified view is an uncached, forced render (see
  // `verified`'s own doc above) — nofollow keeps a crawler from walking every
  // page of every filtered grid on top of the unfiltered site it already
  // crawls, without touching indexability (that's `noindex`, set separately).
  const rel = (base?: string) => (verified ? [base, "nofollow"].filter(Boolean).join(" ") : base);

  return (
    <nav
      aria-label="Pagination"
      data-testid="pagination"
      className="mt-8 border-t border-line pt-6"
    >
      <ul className="flex list-none flex-wrap items-center gap-2 p-0">
        {page > 1 && (
          <li>
            <a href={href(page - 1)} rel={rel("prev")} className={LINK}>
              Previous
            </a>
          </li>
        )}

        {pageWindow(page, totalPages).map((slot, i) => {
          if (slot === "gap") {
            return (
              // Not a link, and not announced: it stands for the pages between
              // two links, and a screen reader reading "ellipsis" here is noise.
              <li key={`gap-${i}`} aria-hidden="true" className="px-1 text-muted">
                &hellip;
              </li>
            );
          }
          return (
            <li key={slot}>
              {slot === page ? (
                <span
                  aria-current="page"
                  className={CURRENT}
                >
                  {slot}
                </span>
              ) : (
                <a href={href(slot)} rel={rel()} className={LINK} aria-label={`Page ${slot}`}>
                  {slot}
                </a>
              )}
            </li>
          );
        })}

        {page < totalPages && (
          <li>
            <a href={href(page + 1)} rel={rel("next")} className={LINK}>
              Next
            </a>
          </li>
        )}
      </ul>
    </nav>
  );
}
