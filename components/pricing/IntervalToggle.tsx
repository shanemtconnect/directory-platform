import { INTERVALS, type Interval } from "@/lib/pricing";

/**
 * A pair of links, not a button with an onClick. /pricing is the page the money
 * arrives through, so it has to switch interval on a device where the bundle
 * has not loaded, or has failed. The state lives in the URL, which also makes
 * the monthly view linkable and shareable.
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
    <nav aria-label="Billing interval" data-testid="interval-toggle">
      <ul>
        {INTERVALS.map((interval) => {
          const current = interval === active;
          return (
            <li key={interval}>
              <a
                href={`/pricing?interval=${interval}`}
                aria-current={current ? "true" : undefined}
                data-interval={interval}
                data-active={current}
                rel="nofollow"
              >
                {labels[interval]}
              </a>
            </li>
          );
        })}
      </ul>
      {savingNote && <p data-testid="saving-note">{savingNote}</p>}
    </nav>
  );
}
