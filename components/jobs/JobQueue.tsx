import { approveJobAction } from "@/lib/actions/jobs";
import type { PendingJob } from "@/lib/db/queries/job-board";
import { EmptyState } from "@/components/ui/EmptyState";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { formatBudget, formatJobDate } from "./format";
import { RejectJobForm } from "./RejectJobForm";

/**
 * The admin's queue: every post that is pending AND settled. Approve is the
 * only primary button on the page; rejection needs a reason.
 */
export function JobQueue({ queue }: { queue: PendingJob[] }) {
  if (queue.length === 0) {
    return (
      <EmptyState title="Nothing waiting" testId="jobs-queue-empty">
        New posts appear here once they are paid for, or straight away when a Verified owner posts free.
      </EmptyState>
    );
  }
  return (
    <ul className="m-0 grid list-none gap-4 p-0" data-testid="jobs-queue">
      {queue.map((job) => {
        const heading = `job-${job.id}`;
        const budget = formatBudget(job.budgetMin, job.budgetMax);
        return (
          <li key={job.id} className="card m-0" data-testid="jobs-queue-row">
            <h2 id={heading} className="mb-1 text-lg">
              {job.title}
            </h2>
            <p className="mb-2 text-sm text-muted">
              {[job.companyName, job.cityName, job.categoryName].filter(Boolean).join(" · ")}
              {" · "}
              <span className={`pill ${job.paymentStatus === "paid" ? "pill-primary" : ""}`}>
                {job.paymentStatus === "paid" ? "Paid" : "Free (Verified owner)"}
              </span>
            </p>
            <dl className="kv">
              <dt>Posted by</dt>
              <dd>
                {job.posterName ?? "—"}
                {job.posterEmail && (
                  <>
                    {" "}
                    <a href={`mailto:${job.posterEmail}`}>{job.posterEmail}</a>
                  </>
                )}
              </dd>
              {budget && (
                <>
                  <dt>Budget</dt>
                  <dd>{budget}</dd>
                </>
              )}
              <dt>Received</dt>
              <dd>{formatJobDate(job.createdAt)}</dd>
            </dl>
            {job.description && <p className="whitespace-pre-line">{job.description}</p>}
            <div className="action-bar" role="group" aria-labelledby={heading}>
              <form action={approveJobAction}>
                <input type="hidden" name="jobId" value={job.id} />
                <SubmitButton pending={false} pendingLabel="Approving…" testId="approve-job">
                  Approve and publish
                </SubmitButton>
              </form>
              <details>
                <summary className="btn btn-secondary">Turn down…</summary>
                <RejectJobForm jobId={job.id} />
              </details>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
