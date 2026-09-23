import { siteConfig } from "@/config/site.config";
import type { PublicJob } from "@/lib/db/queries/job-board";
import { jobsBoardPath } from "@/lib/jobs/routes";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { ApplyLink } from "./ApplyLink";
import { formatBudget, formatJobDate } from "./format";

/**
 * What the job page shows, and — returned alongside — what it showed, so the
 * JSON-LD builder is handed the same answers rather than re-deriving them.
 */
export function renderedJobFields(job: PublicJob): { description: string | null; budgetShown: boolean } {
  const description = job.description?.trim() ? job.description.trim() : null;
  return { description, budgetShown: formatBudget(job.budgetMin, job.budgetMax) !== null };
}

export function JobDetail({ job }: { job: PublicJob }) {
  const { description, budgetShown } = renderedJobFields(job);
  const budget = budgetShown ? formatBudget(job.budgetMin, job.budgetMax) : null;
  const applyHref =
    job.applyMethod === "email" && job.applyEmail
      ? `mailto:${job.applyEmail}?subject=${encodeURIComponent(`Application: ${job.title}`)}`
      : job.applyMethod === "url" && job.applyUrl
        ? job.applyUrl
        : null;
  const back = jobsBoardPath({ citySlug: job.citySlug, categorySlug: job.categorySlug });

  return (
    <main data-testid="job-detail" data-open={String(job.open)}>
      <article className="mx-auto max-w-3xl">
        <PageHeader
          title={job.title}
          back={{ href: back, label: "All jobs" }}
          lede={[job.companyName, job.cityName, job.categoryName].filter(Boolean).join(" · ")}
        >
          {job.publishedAt && (
            <span className="text-sm text-muted">
              Posted <time dateTime={job.publishedAt.toISOString()}>{formatJobDate(job.publishedAt)}</time>
            </span>
          )}
        </PageHeader>

        {!job.open && (
          <Notice variant="status" testId="job-closed" title="This job has closed">
            <p className="mb-0">
              It is no longer taking applications. <a href="/jobs">See the jobs that are open.</a>
            </p>
          </Notice>
        )}

        <dl className="kv">
          {job.companyName && (
            <>
              <dt>Hiring</dt>
              <dd data-testid="job-company">{job.companyName}</dd>
            </>
          )}
          {job.cityName && (
            <>
              <dt>Where</dt>
              <dd>
                {job.cityName}
                {job.cityRegion ? `, ${job.cityRegion}` : ""}
              </dd>
            </>
          )}
          {budget && (
            <>
              <dt>Budget</dt>
              <dd data-testid="job-budget">{budget}</dd>
            </>
          )}
          {job.expiresAt && job.open && (
            <>
              <dt>Closes</dt>
              <dd>
                <time dateTime={job.expiresAt.toISOString()}>{formatJobDate(job.expiresAt)}</time>
              </dd>
            </>
          )}
        </dl>

        {description && (
          <section aria-labelledby="job-about">
            <h2 id="job-about">About the role</h2>
            {description.split(/\n{2,}/).map((para, i) => (
              <p key={i} data-testid="job-description">
                {para}
              </p>
            ))}
          </section>
        )}

        {job.open && applyHref && (
          <p className="form-actions">
            <ApplyLink jobId={job.id} href={applyHref} external={job.applyMethod === "url"} />
            {job.applyMethod === "url" && (
              <small className="block text-muted">Applications are taken on the employer&rsquo;s own site.</small>
            )}
          </p>
        )}

        <p className="text-sm text-muted">
          Posted on {siteConfig.name}. We publish every job by hand and take a post down when its date
          passes; we do not see or keep applications.
        </p>
      </article>
    </main>
  );
}
