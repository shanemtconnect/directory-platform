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

/**
 * Every paginated link is a real <a href> to a real, server-rendered URL.
 * GeoDirectory's demo uses javascript:void(0) and pages 2+ of every category
 * are effectively invisible to crawlers. There is a CI test asserting this.
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
    <nav aria-label="Pagination" data-testid="pagination">
      <ul style={{ display: "flex", gap: "0.5rem", listStyle: "none", padding: 0 }}>
        {page > 1 && (
          <li><a href={href(page - 1)} rel="prev">Previous</a></li>
        )}
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
          <li key={n}>
            {n === page ? (
              <span aria-current="page">{n}</span>
            ) : (
              <a href={href(n)}>{n}</a>
            )}
          </li>
        ))}
        {page < totalPages && (
          <li><a href={href(page + 1)} rel="next">Next</a></li>
        )}
      </ul>
    </nav>
  );
}
