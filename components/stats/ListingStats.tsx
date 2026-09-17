import { siteConfig } from "@/config/site.config";
import type { ListingStatsResult, StatsDay } from "@/lib/db/queries/stats";
import { SPARKLINE_BOX, sparkline } from "./sparkline";

/**
 * The owner's ROI panel: what the listing did, in numbers.
 *
 * A server component that renders data it is handed. It does not query, does
 * not read the clock and does not know who is looking — the page fetches
 * `listingStats(db, viewer, id, days)`, which is where the owner/admin gate
 * lives (constraint 24: query functions enforce it, never the page and never
 * the component).
 *
 * Rendered as a table with a sparkline beside it rather than as a chart. The
 * table is the data — readable by a screen reader, copyable into a
 * spreadsheet, and correct with CSS off — and the line is decoration that
 * makes the shape visible at a glance.
 */

export interface ListingStatsProps {
  /** From `listingStats(db, viewer, listingId, days)`. */
  stats: ListingStatsResult;
  /** Section heading. Defaults to "Performance". */
  heading?: string;
  /** So the page owns its own outline. Defaults to `h2`. */
  headingLevel?: "h2" | "h3";
  /** Where "see further back" points. Defaults to `/pricing`. */
  upgradeHref?: string;
  /**
   * Days listed in the table, most recent first. The totals always cover the
   * whole window; a year of rows is a scroll nobody reads. Defaults to 30.
   */
  maxRows?: number;
  /** Rendered under the totals — e.g. an export link on a tier that allows one. */
  children?: React.ReactNode;
}

interface Metric {
  key: keyof Omit<StatsDay, "day">;
  label: string;
  hint: string;
}

/**
 * Labels are generic on purpose — every one of these means the same thing in
 * any niche this repo is cloned into. The one place the niche shows through is
 * the hint, which names the thing being listed from `siteConfig.entity`.
 */
const METRICS: Metric[] = [
  {
    key: "views",
    label: "Page views",
    hint: `People who opened your ${siteConfig.entity.singular} page.`,
  },
  {
    key: "impressions",
    label: "Listed in results",
    hint: `Times your ${siteConfig.entity.singular} appeared in a list someone was browsing.`,
  },
  { key: "enquiries", label: "Enquiries", hint: "Messages sent to you through the site." },
  { key: "shortlistAdds", label: "Saves", hint: "Times someone saved you to a shortlist." },
  { key: "badgeClicks", label: "Badge clicks", hint: "Visits from the badge on your own website." },
];

function formatNumber(n: number): string {
  return n.toLocaleString(siteConfig.locale);
}

/** `2026-09-12` → the reader's short date. Parsed as UTC noon so it cannot slip a day. */
function formatDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(siteConfig.locale, {
    day: "numeric",
    month: "short",
  });
}

export function ListingStats({
  stats,
  heading = "Performance",
  headingLevel = "h2",
  upgradeHref = "/pricing",
  maxRows = 30,
  children,
}: ListingStatsProps) {
  const Heading = headingLevel;
  const headingId = `stats-${stats.listingId}`;
  const line = sparkline(stats.days.map((d) => d.views));
  const rows = [...stats.days].reverse().slice(0, Math.max(1, maxRows));
  const everythingZero = METRICS.every((m) => stats.totals[m.key] === 0);

  return (
    <section aria-labelledby={headingId} data-testid="listing-stats">
      <Heading id={headingId}>{heading}</Heading>

      <p className="text-muted">
        {stats.listingName} · last {formatNumber(stats.windowDays)}{" "}
        {stats.windowDays === 1 ? "day" : "days"}
      </p>

      <dl data-testid="stats-totals" className="card grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {METRICS.map((m) => (
          <div key={m.key}>
            <dt className="text-sm font-medium text-muted">{m.label}</dt>
            <dd
              data-testid={`stats-total-${m.key}`}
              className="font-heading text-2xl font-semibold text-ink"
            >
              {formatNumber(stats.totals[m.key])}
            </dd>
            <dd className="text-sm text-muted">{m.hint}</dd>
          </div>
        ))}
      </dl>

      {everythingZero ? (
        <p data-testid="stats-empty">
          Nothing recorded yet. Counts start from the day this listing went live and appear here
          within a few minutes of each visit.
        </p>
      ) : (
        line && (
          <svg
            data-testid="stats-sparkline"
            viewBox={`0 0 ${SPARKLINE_BOX.width} ${SPARKLINE_BOX.height}`}
            // The table below is the data. The line is a second reading of it,
            // so it is hidden from assistive technology rather than duplicated.
            aria-hidden="true"
            focusable="false"
            className="my-4 block h-20 w-full"
            preserveAspectRatio="none"
          >
            <polyline
              points={line.points}
              fill="none"
              stroke="var(--color-primary)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )
      )}

      <div className="table-scroll">
        <table data-testid="stats-table">
          <caption className="sr-only">
            Daily counts for {stats.listingName}, most recent first.
          </caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {METRICS.map((m) => (
                <th key={m.key} scope="col">{m.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.day}>
                <th scope="row">
                  <time dateTime={d.day}>{formatDay(d.day)}</time>
                </th>
                {METRICS.map((m) => (
                  <td key={m.key}>{formatNumber(d[m.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length < stats.days.length && (
        <p className="text-muted">
          <small>
            Showing the last {formatNumber(rows.length)} days. The totals above cover all{" "}
            {formatNumber(stats.windowDays)}.
          </small>
        </p>
      )}

      {stats.capped && (
        <p data-testid="stats-window-capped">
          Your plan keeps {formatNumber(stats.capDays)} days of history.{" "}
          <a href={upgradeHref}>Upgrade to see further back.</a>
        </p>
      )}

      {children}
    </section>
  );
}
