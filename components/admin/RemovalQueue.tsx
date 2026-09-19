"use client";

import { useActionState } from "react";
import { siteConfig } from "@/config/site.config";
import { REMOVAL_RELATIONSHIP_LABELS } from "@/lib/trust/labels";
import {
  actionRemovalAction,
  rejectRemovalAction,
  type QueueState,
} from "@/lib/actions/admin-trust";
import { REJECTION_REASON_MIN_LENGTH } from "@/lib/trust/rejection";
import type { OpenRemovalRequest, RemovalRelationship } from "@/lib/db/queries/trust";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * People who have asked to come off the site, nearest deadline first.
 *
 * This is the one queue on the site with a regulator at the end of it: the
 * removal page promises a decision inside `REMOVAL_SLA_WORKING_DAYS` working
 * days, `due_at` is the date that promise was made for, and the query orders
 * on it rather than on arrival. The overdue marker is the whole point of the screen — a request
 * three days late looks identical to a fresh one without it.
 *
 * A client component for the same reason the report queue is: two admins on the
 * same row, and a takedown that quietly did nothing the second time is the
 * worst possible thing for it to do.
 */

const INITIAL: QueueState = { status: "idle" };

function when(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    dateStyle: "medium",
    timeZone: siteConfig.timezone,
  }).format(value);
}

/**
 * Late, and by how much. `now` comes down from the server render so the HTML
 * the server sent and the client's first render say the same thing.
 *
 * A row with no `due_at` predates the SLA column; it is shown as unknown rather
 * than assumed safe, because "we cannot tell whether this is late" is a thing
 * an admin should act on.
 */
export function dueState(
  dueAt: Date | null,
  now: Date,
): { overdue: boolean; label: string } {
  if (dueAt === null) return { overdue: false, label: "No deadline recorded" };
  if (dueAt.getTime() >= now.getTime()) return { overdue: false, label: `Due ${when(dueAt)}` };

  const days = Math.max(1, Math.round((now.getTime() - dueAt.getTime()) / 86_400_000));
  return { overdue: true, label: `Overdue by ${days === 1 ? "1 day" : `${days} days`}` };
}

function isRelationship(value: string | null): value is RemovalRelationship {
  return value !== null && value in REMOVAL_RELATIONSHIP_LABELS;
}

function relationshipLabel(value: string | null): string {
  if (isRelationship(value)) return REMOVAL_RELATIONSHIP_LABELS[value];
  return "Relationship not given";
}

function RemovalCard({ request, now }: { request: OpenRemovalRequest; now: Date }) {
  const [taken, action, actioning] = useActionState(actionRemovalAction, INITIAL);
  const [rejected, reject, rejecting] = useActionState(rejectRemovalAction, INITIAL);
  const failure =
    (taken.status === "error" ? taken.message : null) ??
    (rejected.status === "error" ? rejected.message : null) ??
    null;
  const due = dueState(request.dueAt, now);
  const done = taken.status === "done" || rejected.status === "done";
  const titleId = `removal-${request.id}-title`;

  return (
    <li className="card mb-3" data-testid={`removal-${request.id}`}>
      <h2 className="mt-0 text-lg" id={titleId}>
        <a href={request.listingPath}>{request.listingName}</a>
      </h2>

      <p className="text-sm">
        {due.overdue ? (
          <strong className="pill pill-danger uppercase tracking-wide" data-testid="removal-overdue">
            {due.label}
          </strong>
        ) : (
          <span className="text-muted">{due.label}</span>
        )}
        <span className="text-muted"> · asked on {when(request.createdAt)}</span>
      </p>

      <dl className="kv">
        <dt>Who is asking</dt>
        <dd>
          {request.requesterName ?? <span className="text-muted">name not given</span>}
          {request.requesterEmail !== null && (
            <>
              {" "}
              <a href={`mailto:${request.requesterEmail}`}>{request.requesterEmail}</a>
            </>
          )}
        </dd>

        <dt>How they are connected</dt>
        <dd>{relationshipLabel(request.relationship)}</dd>
      </dl>

      <p className="whitespace-pre-line" data-testid="removal-reason">
        {request.reason ?? <span className="text-muted">No reason was given.</span>}
      </p>

      <p className="text-sm">
        <a href={`/admin/submissions/${request.listingId}`}>Open the record</a> ·{" "}
        <a href={request.listingPath}>See the live page</a>
      </p>

      {failure !== null && (
        <Notice variant="error" testId="removal-error">
          {failure}
        </Notice>
      )}
      {done && failure === null && (
        <Notice variant="success" testId="removal-done">
          Done — this request is settled and leaves the queue on the next load.
        </Notice>
      )}

      <p className="mt-2 text-sm text-muted">
        Actioning takes the page down, writes a suppression so the next import cannot put it back,
        and emails {request.requesterEmail ?? "the requester"}.
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-sm">Turn this request down instead</summary>
        <p className="text-sm text-muted">
          The {siteConfig.entity.singular} stays exactly where it is and the requester is emailed
          that we are not removing it, along with the reason you give here. Only do this where
          there is a reason to keep the entry — a request from somebody with no connection to it,
          or one already settled elsewhere — and write it as you would say it to them, because
          that is who reads it.
        </p>
        <form action={reject}>
          <input type="hidden" name="removalRequestId" value={request.id} />
          <input type="hidden" name="listingId" value={request.listingId} />
          <label className="block text-sm" htmlFor={`rejection-reason-${request.id}`}>
            Why we are not removing it
          </label>
          <textarea
            id={`rejection-reason-${request.id}`}
            name="reason"
            required
            minLength={REJECTION_REASON_MIN_LENGTH}
            rows={3}
            className="mb-2 block w-full"
            data-testid="removal-reject-reason"
          />
          <SubmitButton pending={rejecting} pendingLabel="Saving…" variant="secondary" testId="removal-reject">
            Reject the request
          </SubmitButton>
        </form>
      </details>

      <div className="action-bar" role="group" aria-labelledby={titleId}>
        <form action={action}>
          <input type="hidden" name="removalRequestId" value={request.id} />
          <input type="hidden" name="listingId" value={request.listingId} />
          <SubmitButton pending={actioning} pendingLabel="Removing…" testId="removal-action">
            Action the removal
          </SubmitButton>
        </form>
      </div>
    </li>
  );
}

export function RemovalQueue({
  requests,
  now,
}: {
  requests: OpenRemovalRequest[];
  now: Date;
}) {
  if (requests.length === 0) {
    return (
      <EmptyState title="Nothing is waiting to come down." testId="removal-queue-empty">
        <p>Requests sent from a {siteConfig.entity.singular} page land here.</p>
      </EmptyState>
    );
  }

  return (
    <ul className="m-0 list-none p-0" data-testid="removal-queue">
      {requests.map((request) => (
        <RemovalCard key={request.id} request={request} now={now} />
      ))}
    </ul>
  );
}
