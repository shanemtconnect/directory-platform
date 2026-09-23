import type { PublicJobCard } from "@/lib/db/queries/job-board";
import { formatBudget, formatJobDate } from "./format";

/** One row on the board. The whole card is a real link to the job page. */
export function JobCard({ job }: { job: PublicJobCard }) {
  const budget = formatBudget(job.budgetMin, job.budgetMax);
  return (
    <li className="card card-hover m-0 list-none" data-testid="job-card">
      <h2 className="mb-1 text-lg">
        <a href={job.path} className="no-underline" data-testid="job-card-link">
          {job.title}
        </a>
      </h2>
      <p className="mb-2 text-sm text-muted">
        {job.companyName && <span data-testid="job-card-company">{job.companyName}</span>}
        {job.companyName && job.cityName && " · "}
        {job.cityName && <span>{job.cityName}</span>}
        {job.categoryName && <span> · {job.categoryName}</span>}
      </p>
      <p className="mb-0 text-sm">
        {budget && <span className="pill pill-primary mr-2">{budget}</span>}
        {job.publishedAt && (
          <span className="text-muted">
            Posted <time dateTime={job.publishedAt.toISOString()}>{formatJobDate(job.publishedAt)}</time>
          </span>
        )}
      </p>
    </li>
  );
}
