import { siteConfig } from "@/config/site.config";
import type { AuditEntry } from "@/lib/db/queries/admin/audit";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * The trail. Read-only by design — an audit log that can be edited from the
 * screen that displays it is not an audit log.
 *
 * The filter is a path segment (`/admin/audit/city`), not `?type=city`: global
 * constraint 12, and reading searchParams forces the route dynamic in Next 16.
 */
function when(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: siteConfig.timezone,
  }).format(value);
}

/** jsonb comes back as unknown. Rendered compactly, never as [object Object]. */
function meta(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function AuditFilter({ types, current }: { types: string[]; current: string | null }) {
  return (
    <nav aria-label="Filter by entity" className="mb-4 flex flex-wrap gap-2">
      <a
        href="/admin/audit"
        aria-current={current === null ? "page" : undefined}
        className={`pill min-h-11 inline-flex items-center no-underline ${current === null ? "pill-primary" : ""}`}
      >
        Everything
      </a>
      {types.map((type) => (
        <a
          key={type}
          href={`/admin/audit/${type}`}
          aria-current={current === type ? "page" : undefined}
          className={`pill min-h-11 inline-flex items-center no-underline ${current === type ? "pill-primary" : ""}`}
        >
          {type}
        </a>
      ))}
    </nav>
  );
}

export function AuditTable({ rows }: { rows: AuditEntry[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState title="Nothing has been recorded under this filter yet." testId="audit-empty">
        <p>Every approval, rejection, edit and takedown writes a row here as it happens.</p>
      </EmptyState>
    );
  }

  return (
    <div className="table-scroll">
      <table data-testid="audit-table" className="table-cards">
        <caption>The {rows.length} most recent entries, newest first.</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">Action</th>
            <th scope="col">Entity</th>
            <th scope="col">Detail</th>
            <th scope="col">IP</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td data-label="When">
                <time dateTime={row.createdAt.toISOString()}>{when(row.createdAt)}</time>
              </td>
              <td data-label="Who">{row.actor ?? <span className="text-muted">not signed in</span>}</td>
              <td data-label="Action">{row.action}</td>
              <td data-label="Entity">
                {row.entityType ?? "—"}
                {row.entityId !== null && (
                  <>
                    <br />
                    <small className="font-mono">{row.entityId}</small>
                  </>
                )}
              </td>
              <td data-label="Detail" className="max-w-sm break-words text-sm">{meta(row.meta)}</td>
              <td data-label="IP" className="text-sm">{row.ip ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
