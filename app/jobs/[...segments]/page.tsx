import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { getPublicJob } from "@/lib/db/queries/job-board";
import { features } from "@/lib/features/flags";
import { guardFeature } from "@/lib/features/guard";
import { parseJobsPath, jobsBoardPath } from "@/lib/jobs/routes";
import { jobPostingSchema } from "@/lib/jobs/schema";
import { breadcrumbSchema, siteUrl } from "@/lib/schema/builders";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import { JobDetail, renderedJobFields } from "@/components/jobs/JobDetail";
import { JsonLd } from "@/components/seo/JsonLd";
import { jobsBoardMetadata, renderJobsBoard } from "../board";

/**
 * Everything under /jobs/ that is not the bare board: pages, filters, and
 * one job. The grammar is lib/jobs/routes.ts; this file only acts on what
 * it says. ISR-cached like the pillar pages, and for the same reason: the
 * board is a crawl target, and a query-string page would never enter the
 * cache.
 */
export const revalidate = 300;

/** Empty, so the route is static-with-dynamicParams rather than fully dynamic. */
export async function generateStaticParams(): Promise<{ segments: string[] }[]> {
  return [];
}

interface Props {
  params: Promise<{ segments: string[] }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  if (!features.jobBoard) return {};
  const route = parseJobsPath((await params).segments);
  if (route.kind === "board") return jobsBoardMetadata(route);
  if (route.kind !== "job") return {};

  const job = await getPublicJob(db, PUBLIC_VIEWER, route.id);
  if (job === null) return {};
  const title = [job.title, job.companyName, job.cityName].filter(Boolean).join(" — ");
  const description = job.open
    ? `${job.title}${job.companyName ? ` at ${job.companyName}` : ""}${job.cityName ? ` in ${job.cityName}` : ""}. Posted on ${siteConfig.name}.`
    : `This job has closed. See the open jobs on ${siteConfig.name}.`;
  return {
    title,
    description,
    alternates: { canonical: siteUrl(job.path) },
    // A closed job stays a page for the people who hold the link, but it is
    // not a page to send searchers to.
    robots: job.open ? undefined : { index: false, follow: true },
    openGraph: pageOpenGraph({ title, description, url: siteUrl(job.path) }),
  };
}

export default async function JobsSegmentPage({ params }: Props) {
  guardFeature("jobBoard");
  const route = parseJobsPath((await params).segments);

  switch (route.kind) {
    case "not-found":
      notFound();
    // eslint-disable-next-line no-fallthrough -- notFound() never returns
    case "redirect":
      permanentRedirect(route.to);
    // eslint-disable-next-line no-fallthrough -- permanentRedirect() never returns
    case "board":
      return renderJobsBoard(route);
    case "job": {
      const job = await getPublicJob(db, PUBLIC_VIEWER, route.id);
      if (job === null) notFound();
      // The builder is handed exactly what the page rendered (constraint 11).
      const rendered = renderedJobFields(job);
      const trail = [{ name: "Home", path: "" }, { name: "Jobs", path: "/jobs" }];
      if (job.cityName && job.citySlug) trail.push({ name: job.cityName, path: jobsBoardPath({ citySlug: job.citySlug }) });
      trail.push({ name: job.title, path: job.path });
      return (
        <>
          <JsonLd data={breadcrumbSchema(trail)} />
          <JsonLd data={jobPostingSchema({ job, ...rendered })} />
          <JobDetail job={job} />
        </>
      );
    }
  }
}
