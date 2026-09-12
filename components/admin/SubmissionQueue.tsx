import { siteConfig } from "@/config/site.config";
import type { SubmissionQueue as Queue } from "@/lib/db/queries/admin/submissions";

/**
 * The queue table.
 *
 * Pagination is a real path (`/admin/submissions/page/2`), not `?page=2`:
 * global constraint 12 applies to every list on the site, and reading
 * `searchParams` is what forces a route dynamic in Next 16.
 */
function pagePath(page: number): string {
  return page <= 1 ? "/admin/submissions" : `/admin/submissions/page/${page}`;
}

function when(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: siteConfig.timezone,
  }).format(value);
}

export function SubmissionQueue({ queue }: { queue: Queue }) {
  if (queue.total === 0) {
    return (
      <p data-testid="submission-queue-empty">
        Nothing is waiting. New submissions from the add form land here.
      </p>
    );
  }

  return (
    <>
      <div className="table-scroll">
        <table data-testid="submission-queue">
          <caption>
            {queue.total} waiting — page {queue.page} of {queue.pageCount}, oldest first.
          </caption>
          <thead>
            <tr>
              <th scope="col">{siteConfig.entity.Singular}</th>
              <th scope="col">Town</th>
              <th scope="col">Category</th>
              <th scope="col">Submitted by</th>
              <th scope="col">Asked for</th>
              <th scope="col">Received</th>
            </tr>
          </thead>
          <tbody>
            {queue.rows.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="font-normal">
                  <a href={`/admin/submissions/${row.id}`}>{row.name}</a>
                </th>
                <td>{row.cityName}</td>
                <td>{row.categoryName}</td>
                <td>
                  {row.submitterEmail === null ? (
                    <span className="text-muted">not given</span>
                  ) : (
                    <a href={`mailto:${row.submitterEmail}`}>{row.submitterEmail}</a>
                  )}
                </td>
                <td>{row.requestedTier ?? "—"}</td>
                <td>
                  <time dateTime={row.createdAt.toISOString()}>{when(row.createdAt)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {queue.pageCount > 1 && (
        <nav aria-label="Pagination" className="mt-4 flex gap-4">
          {queue.page > 1 && <a href={pagePath(queue.page - 1)}>Previous page</a>}
          {queue.page < queue.pageCount && <a href={pagePath(queue.page + 1)}>Next page</a>}
        </nav>
      )}
    </>
  );
}
