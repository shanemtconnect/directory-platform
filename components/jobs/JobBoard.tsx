import { siteConfig } from "@/config/site.config";
import type { JobFilterOption, PublicJobCard, ResolvedJobFilters } from "@/lib/db/queries/job-board";
import { jobsBoardPath } from "@/lib/jobs/routes";
import { Pagination } from "@/components/pillar/Pagination";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { JobCard } from "./JobCard";
import { SaveSearchButton } from "@/components/search/SaveSearchButton";
import { features } from "@/lib/features/flags";

export interface JobBoardProps {
  jobs: PublicJobCard[];
  filters: ResolvedJobFilters;
  options: { cities: JobFilterOption[]; categories: JobFilterOption[] };
  page: number;
  totalPages: number;
  total: number;
}

export function boardTitle(filters: ResolvedJobFilters): string {
  if (filters.category && filters.city) return `${filters.category.name} jobs in ${filters.city.name}`;
  if (filters.category) return `${filters.category.name} jobs`;
  if (filters.city) return `Jobs in ${filters.city.name}`;
  return "Jobs";
}

/**
 * The board. Filters are real links to real URLs (never a query string), so
 * every filtered view is its own cached page a crawler can reach. The
 * "Post a job" call to action is always present: the board is where a
 * business realises it can.
 */
export function JobBoard({ jobs, filters, options, page, totalPages, total }: JobBoardProps) {
  const e = siteConfig.entity;
  const title = boardTitle(filters);
  const basePath = jobsBoardPath({ citySlug: filters.city?.slug, categorySlug: filters.category?.slug });

  return (
    <main data-testid="jobs-board">
      <PageHeader
        title={title}
        lede={`Vacancies posted by ${e.plural} and the businesses that work with them. ${total === 1 ? "1 open job" : `${total} open jobs`}.`}
      >
        <a href="/post-a-job" className="btn btn-primary" data-testid="post-a-job-cta">
          Post a job
        </a>
        {/* Saved searches (Task 54): the board's own filters, as listOpenJobs takes them. */}
        {features.savedSearches && (
          <SaveSearchButton
            kind="jobs"
            params={{
              ...(filters.city ? { citySlug: filters.city.slug } : {}),
              ...(filters.category ? { categorySlug: filters.category.slug } : {}),
            }}
            label={title}
            currentPath={basePath}
          />
        )}
      </PageHeader>

      {(options.cities.length > 0 || options.categories.length > 0) && (
        <nav aria-label="Filter jobs" className="mb-6 flex flex-wrap gap-2" data-testid="job-filters">
          {(filters.city || filters.category) && (
            <a href="/jobs" className="pill">
              All jobs
            </a>
          )}
          {options.cities.map((c) => (
            <a
              key={`city-${c.slug}`}
              href={jobsBoardPath({ citySlug: c.slug, categorySlug: filters.category?.slug })}
              className={`pill${filters.city?.slug === c.slug ? " pill-on" : ""}`}
              aria-current={filters.city?.slug === c.slug ? "page" : undefined}
            >
              {c.name} <span className="text-muted">({c.count})</span>
            </a>
          ))}
          {options.categories.map((c) => (
            <a
              key={`cat-${c.slug}`}
              href={jobsBoardPath({ citySlug: filters.city?.slug, categorySlug: c.slug })}
              className={`pill${filters.category?.slug === c.slug ? " pill-on" : ""}`}
              aria-current={filters.category?.slug === c.slug ? "page" : undefined}
            >
              {c.name} <span className="text-muted">({c.count})</span>
            </a>
          ))}
        </nav>
      )}

      {jobs.length === 0 ? (
        <EmptyState
          title="No open jobs here yet"
          testId="jobs-empty"
          action={{ href: "/post-a-job", label: "Post the first one" }}
        >
          Jobs stay on the board for {siteConfig.jobs.durationDays} days after they are approved.
        </EmptyState>
      ) : (
        <ul className="card-grid m-0 grid gap-4 p-0" data-testid="job-list">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </ul>
      )}

      <Pagination basePath={basePath} page={page} totalPages={totalPages} />
    </main>
  );
}
