import { pageWindow } from "./page-window";

interface Props {
  basePath: string;
  page: number;
  totalPages: number;
  /**
   * Search keeps its filters in the query string, so its pagination must too.
   * Pillar pages use path pagination (/city/page/2) because reading
   * searchParams would force the route dynamic and kill their ISR cache —
   * search is already dynamic and noindexed, so the trade-off does not apply.
   */
  searchStyle?: boolean;
}

const LINK =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-token)] border border-line bg-surface px-3 no-underline hover:border-primary";

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
export function Pagination({ basePath, page, totalPages, searchStyle = false }: Props) {
  if (totalPages <= 1) return null;
  const href = (n: number) => {
    if (n === 1) return basePath;
    if (searchStyle) {
      return basePath.includes("?") ? `${basePath}&page=${n}` : `${basePath}?page=${n}`;
    }
    return `${basePath}/page/${n}`;
  };

  return (
    <nav
      aria-label="Pagination"
      data-testid="pagination"
      className="mt-8 border-t border-line pt-6"
    >
      <ul className="flex list-none flex-wrap items-center gap-2 p-0">
        {page > 1 && (
          <li>
            <a href={href(page - 1)} rel="prev" className={LINK}>
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
                  className={`${LINK} border-primary bg-primary font-semibold text-on-primary`}
                >
                  {slot}
                </span>
              ) : (
                <a href={href(slot)} className={LINK} aria-label={`Page ${slot}`}>
                  {slot}
                </a>
              )}
            </li>
          );
        })}

        {page < totalPages && (
          <li>
            <a href={href(page + 1)} rel="next" className={LINK}>
              Next
            </a>
          </li>
        )}
      </ul>
    </nav>
  );
}
