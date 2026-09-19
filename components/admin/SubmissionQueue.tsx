import { siteConfig } from "@/config/site.config";
import type { SubmissionQueue as Queue } from "@/lib/db/queries/admin/submissions";
import { EmptyState } from "@/components/ui/EmptyState";

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
      <EmptyState title="Nothing is waiting." testId="submission-queue-empty">
        <p>New submissions from the add form land here.</p>
      </EmptyState>
    );
  }

  return (
    <>
      <div className="table-scroll">
        <table data-testid="submission-queue" className="table-cards">
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
                <th scope="row" className="font-normal" data-label={siteConfig.entity.Singular}>
                  <a href={`/admin/submissions/${row.id}`}>{row.name}</a>
                </th>
                <td data-label="Town">{row.cityName}</td>
                <td data-label="Category">{row.categoryName}</td>
                <td data-label="Submitted by">
                  {row.submitterEmail === null ? (
                    <span className="text-muted">not given</span>
                  ) : (
                    <a href={`mailto:${row.submitterEmail}`}>{row.submitterEmail}</a>
                  )}
                </td>
                <td data-label="Asked for">{row.requestedTier ?? "—"}</td>
                <td data-label="Received">
                  <time dateTime={row.createdAt.toISOString()}>{when(row.createdAt)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {queue.pageCount > 1 && (
        <nav aria-label="Pagination" className="mt-4 flex flex-wrap gap-3">
          {queue.page > 1 && (
            <a href={pagePath(queue.page - 1)} className="btn btn-secondary">Previous page</a>
          )}
          {queue.page < queue.pageCount && (
            <a href={pagePath(queue.page + 1)} className="btn btn-secondary">Next page</a>
          )}
        </nav>
      )}
    </>
  );
}
