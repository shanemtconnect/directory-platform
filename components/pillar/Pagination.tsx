interface Props {
  basePath: string;
  page: number;
  totalPages: number;
}

/**
 * Every paginated link is a real <a href> to a real, server-rendered URL.
 * GeoDirectory's demo uses javascript:void(0) and pages 2+ of every category
 * are effectively invisible to crawlers. There is a CI test asserting this.
 */
export function Pagination({ basePath, page, totalPages }: Props) {
  if (totalPages <= 1) return null;
  // Path pagination, not ?page= — see the note in app/[...segments]/page.tsx.
  const href = (n: number) => (n === 1 ? basePath : `${basePath}/page/${n}`);

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
