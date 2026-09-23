import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import {
  JOBS_PER_PAGE,
  countOpenJobs,
  jobFilterOptions,
  listOpenJobs,
  resolveJobFilters,
} from "@/lib/db/queries/job-board";
import { jobsBoardPath } from "@/lib/jobs/routes";
import { breadcrumbSchema, siteUrl } from "@/lib/schema/builders";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import { JobBoard, boardTitle } from "@/components/jobs/JobBoard";
import { JsonLd } from "@/components/seo/JsonLd";

/**
 * The board, rendered for /jobs and for every filtered and paginated
 * spelling under app/jobs/[...segments]. One place, so the bare route and the
 * catch-all cannot disagree about a heading, a count or a canonical.
 */
export interface BoardRoute {
  readonly citySlug: string | null;
  readonly categorySlug: string | null;
  readonly page: number;
}

export async function jobsBoardMetadata(route: BoardRoute): Promise<Metadata> {
  const filters = await resolveJobFilters(db, PUBLIC_VIEWER, route);
  if (filters === null) return { title: "Jobs" };
  const title = route.page > 1 ? `${boardTitle(filters)} — page ${route.page}` : boardTitle(filters);
  const path = jobsBoardPath(route, route.page);
  const description = `Open vacancies posted by ${siteConfig.entity.plural} and the businesses that work with them on ${siteConfig.name}.`;
  return {
    title,
    description,
    alternates: { canonical: siteUrl(path) },
    openGraph: pageOpenGraph({ title, description, url: siteUrl(path) }),
  };
}

export async function renderJobsBoard(route: BoardRoute): Promise<ReactNode> {
  const filters = await resolveJobFilters(db, PUBLIC_VIEWER, route);
  if (filters === null) notFound();

  const [total, options] = await Promise.all([
    countOpenJobs(db, PUBLIC_VIEWER, route),
    jobFilterOptions(db, PUBLIC_VIEWER),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / JOBS_PER_PAGE));
  // A page past the end is not a page. Page 1 of nothing is the empty board.
  if (route.page > totalPages) notFound();

  const jobs = await listOpenJobs(db, PUBLIC_VIEWER, route);

  const trail = [{ name: "Home", path: "" }, { name: "Jobs", path: "/jobs" }];
  if (filters.city) trail.push({ name: filters.city.name, path: jobsBoardPath({ citySlug: filters.city.slug }) });
  if (filters.category) trail.push({ name: filters.category.name, path: jobsBoardPath(route) });

  return (
    <>
      <JsonLd data={breadcrumbSchema(trail)} />
      <JobBoard
        jobs={jobs}
        filters={filters}
        options={options}
        page={route.page}
        totalPages={totalPages}
        total={total}
      />
    </>
  );
}
