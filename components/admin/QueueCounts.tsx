import type { ReactNode } from "react";
import type { AdminQueueCounts } from "@/lib/db/queries/admin/dashboard";

/**
 * The dashboard's five tiles: where the work is.
 *
 * A queue with nothing in it is shown as a zero rather than hidden — "no open
 * reports" and "the reports page is broken" look identical when the tile is
 * missing.
 *
 * `href` is null for the queues whose console page is not built yet. A tile
 * that links nowhere is better than one that links to a 404: the number still
 * tells an admin the work exists, which is the point of counting it.
 */
interface Tile {
  label: string;
  value: number;
  href: string | null;
  /** Shown under the number when there is nothing waiting. */
  quiet: string;
}

function tiles(counts: AdminQueueCounts): Tile[] {
  return [
    {
      label: "Submissions waiting",
      value: counts.pendingSubmissions,
      href: "/admin/submissions",
      quiet: "The queue is empty.",
    },
    {
      label: "Towns without intro copy",
      value: counts.citiesAwaitingIntro,
      href: "/admin/cities",
      quiet: "Every published town has copy.",
    },
    {
      label: "Claims pending",
      value: counts.pendingClaims,
      href: null,
      quiet: "Nobody is waiting on a decision.",
    },
    {
      label: "Reports open",
      value: counts.openReports,
      href: "/admin/reports",
      quiet: "Nothing has been reported.",
    },
    {
      label: "Removal requests open",
      value: counts.openRemovals,
      href: "/admin/removals",
      quiet: "Nothing is waiting to come down.",
    },
  ];
}

function Body({ tile }: { tile: Tile }): ReactNode {
  return (
    <>
      <span className="block text-sm font-semibold uppercase tracking-wide text-muted">
        {tile.label}
      </span>
      <strong className="mt-1 block text-4xl leading-none text-ink">{tile.value}</strong>
      {tile.value === 0 && <span className="mt-2 block text-sm text-muted">{tile.quiet}</span>}
    </>
  );
}

export function QueueCounts({ counts }: { counts: AdminQueueCounts }) {
  return (
    <ul className="card-grid" data-testid="admin-counts">
      {tiles(counts).map((tile) => (
        <li key={tile.label}>
          {tile.href === null ? (
            <div className="card h-full">
              <Body tile={tile} />
            </div>
          ) : (
            <a href={tile.href} className="card card-hover block h-full no-underline">
              <Body tile={tile} />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
