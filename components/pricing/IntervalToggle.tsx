import { DEFAULT_INTERVAL, INTERVALS, intervalPath, type Interval } from "@/lib/pricing";

/**
 * A pair of links, not a button with an onClick. /pricing is the page the money
 * arrives through, so it has to switch interval on a device where the bundle
 * has not loaded, or has failed. The state lives in the PATH — a query string
 * would force the route dynamic in Next 16 and drop the page out of the ISR
 * cache — which also makes the monthly view linkable and shareable.
 */
export function IntervalToggle({
  active,
  labels,
  savingNote,
}: {
  active: Interval;
  labels: Readonly<Record<Interval, string>>;
  savingNote?: string;
}) {
  return (
    <nav aria-label="Billing interval" data-testid="interval-toggle" className="mt-6">
      <ul className="inline-flex list-none gap-1 rounded-[var(--radius-token)] border border-line bg-surface p-1">
        {INTERVALS.map((interval) => {
          const current = interval === active;
          return (
            <li key={interval}>
              <a
                href={intervalPath(interval)}
                aria-current={current ? "true" : undefined}
                data-interval={interval}
                data-active={current}
                className={
                  current
                    ? "inline-flex min-h-11 items-center rounded-[calc(var(--radius-token)-0.25rem)] bg-primary px-4 font-semibold text-on-primary no-underline"
                    : "inline-flex min-h-11 items-center rounded-[calc(var(--radius-token)-0.25rem)] px-4 text-ink no-underline hover:bg-raised"
                }
                // The non-default interval canonicalises to /pricing, so its
                // link is not one we are asking a crawler to follow.
                rel={interval === DEFAULT_INTERVAL ? undefined : "nofollow"}
              >
                {labels[interval]}
              </a>
            </li>
          );
        })}
      </ul>
      {savingNote && <p data-testid="saving-note" className="mt-3 text-sm text-muted">{savingNote}</p>}
    </nav>
  );
}
