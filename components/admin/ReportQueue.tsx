"use client";

import { useActionState } from "react";
import { siteConfig } from "@/config/site.config";
import { REPORT_REASON_LABELS } from "@/lib/trust/labels";
import {
  dismissReportAction,
  markReportActionedAction,
  type QueueState,
} from "@/lib/actions/admin-trust";
import type { OpenReport } from "@/lib/db/queries/trust";

/**
 * Everything somebody has told us is wrong, newest first.
 *
 * A client component, and the reason is the pair of buttons: two admins can be
 * looking at this queue at once, and the interesting failure is the second one
 * clicking a row the first has already dealt with. A plain form action would
 * redirect back to a queue the row has vanished from, which looks exactly like
 * success. `useActionState` gives the row somewhere to say "somebody has
 * already decided this one".
 *
 * Newest first is the query's doing, not this component's — a report is a
 * correction, and the newest one is the most likely to still be true.
 */

const INITIAL: QueueState = { status: "idle" };

function when(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: siteConfig.timezone,
  }).format(value);
}

/**
 * How long it has been sitting there, in the largest unit that still says
 * something. `now` is passed down from the server render rather than read here,
 * so the server HTML and the client's first render agree.
 */
export function age(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

function ReportCard({ report, now }: { report: OpenReport; now: Date }) {
  const [dismissed, dismiss, dismissing] = useActionState(dismissReportAction, INITIAL);
  const [actioned, markActioned, marking] = useActionState(markReportActionedAction, INITIAL);
  const failure =
    (dismissed.status === "error" ? dismissed.message : null) ??
    (actioned.status === "error" ? actioned.message : null) ??
    null;

  return (
    <li className="card mb-3" data-testid={`report-${report.id}`}>
      <h2 className="mt-0 text-lg">
        <a href={report.listingPath}>{report.listingName}</a>
      </h2>
      <p className="text-sm text-muted">
        <strong className="text-ink">{REPORT_REASON_LABELS[report.reason]}</strong> ·{" "}
        <time dateTime={report.createdAt.toISOString()} title={when(report.createdAt)}>
          {age(report.createdAt, now)}
        </time>
      </p>

      {report.detail === null ? (
        <p className="text-muted">No detail was given.</p>
      ) : (
        <p className="whitespace-pre-line" data-testid="report-detail">
          {report.detail}
        </p>
      )}

      <p className="text-sm">
        {report.reporterEmail === null ? (
          <span className="text-muted">Reported anonymously — there is nobody to write back to.</span>
        ) : (
          <>
            Reported by <a href={`mailto:${report.reporterEmail}`}>{report.reporterEmail}</a>
          </>
        )}
      </p>

      <p className="text-sm">
        <a href={`/admin/submissions/${report.listingId}`}>Open the record</a> ·{" "}
        <a href={report.listingPath}>See the live page</a>
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <form action={markActioned}>
          <input type="hidden" name="reportId" value={report.id} />
          <button type="submit" disabled={marking} data-testid="report-actioned">
            {marking ? "Saving…" : "Mark actioned"}
          </button>
        </form>
        <form action={dismiss}>
          <input type="hidden" name="reportId" value={report.id} />
          <button type="submit" disabled={dismissing} data-testid="report-dismiss">
            {dismissing ? "Saving…" : "Dismiss"}
          </button>
        </form>
      </div>

      {failure !== null && (
        <p role="alert" className="mt-2 text-sm" data-testid="report-error">
          {failure}
        </p>
      )}
    </li>
  );
}

export function ReportQueue({ reports, now }: { reports: OpenReport[]; now: Date }) {
  if (reports.length === 0) {
    return (
      <p data-testid="report-queue-empty">
        Nothing has been reported. Corrections sent from a {siteConfig.entity.singular} page land
        here.
      </p>
    );
  }

  return (
    <ul className="m-0 list-none p-0" data-testid="report-queue">
      {reports.map((report) => (
        <ReportCard key={report.id} report={report} now={now} />
      ))}
    </ul>
  );
}
