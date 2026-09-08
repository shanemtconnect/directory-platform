import { notFound, permanentRedirect, redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { resolveRoute } from "@/lib/routing/resolve";
import { listListings, countListings, PER_PAGE } from "@/lib/db/queries/listings";
import { pillarHeading } from "@/lib/db/queries/cities";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { PillarPage } from "@/components/pillar/PillarPage";

export const revalidate = 3600;

/**
 * Deliberately empty.
 *
 * A catch-all with no generateStaticParams is treated as fully dynamic — the
 * route renders on every request and never enters the ISR cache, which for a
 * 5,000-page directory is the difference between a cached site and a database
 * hammered on every crawl. Exporting this (even empty) marks the route as
 * statically generated with dynamicParams, so a page renders on first request
 * and is then cached in Redis under `revalidate`.
 *
 * Empty rather than enumerated because the Docker image is built in CI with no
 * DATABASE_URL. Pre-rendering the top cities at build would need one, and the
 * first-request cost is a single render per page.
 */
export async function generateStaticParams(): Promise<{ segments: string[] }[]> {
  return [];
}

interface Props {
  params: Promise<{ segments: string[] }>;
}

// No searchParams: reading them forces the route dynamic in Next 16, which
// would keep the city pillar pages out of the ISR cache entirely. Pagination
// lives in the path instead — /[city]/page/2.
/** Strips any trailing /page/N so pagination links build from the clean path. */
function pillarBasePath(segments: string[]): string {
  const rest =
    segments.length >= 2 && segments[segments.length - 2] === "page"
      ? segments.slice(0, -2)
      : segments;
  return `/${rest.join("/")}`;
}

export default async function CatchAllPage({ params }: Props) {
  const { segments } = await params;

  const result = await resolveRoute(db as never, segments, siteConfig.siteMode);

  switch (result.kind) {
    case "not-found":
      notFound();

    case "redirect":
      if (result.status === 301) permanentRedirect(result.to);
      redirect(result.to);

    // Phase 2 renders the detail page. Phase 1 proves resolution reaches it.
    case "listing":
      return (
        <main>
          <h1>Listing</h1>
          <p data-testid="listing-id">{result.listingId}</p>
        </main>
      );

    case "pillar": {
      const heading = await pillarHeading(
        db as never, PUBLIC_VIEWER, result.scope, siteConfig.entity.Plural,
      );
      if (!heading) notFound();

      const [rows, total] = await Promise.all([
        listListings(db as never, PUBLIC_VIEWER, result.scope, { page: result.page }),
        countListings(db as never, PUBLIC_VIEWER, result.scope),
      ]);

      return (
        <PillarPage
          heading={heading}
          listings={rows}
          page={result.page}
          totalPages={Math.max(1, Math.ceil(total / PER_PAGE))}
          basePath={pillarBasePath(segments)}
        />
      );
    }
  }
}

/**
 * A city that has not earned indexing renders and works, but is noindex,follow
 * and stays out of the sitemap. This is the single most important SEO rule in
 * the build — thin one-listing city pages drag the whole domain down.
 */
export async function generateMetadata({ params }: Props) {
  const { segments } = await params;
  const result = await resolveRoute(db as never, segments, siteConfig.siteMode);
  if (result.kind !== "pillar") return {};

  const heading = await pillarHeading(
    db as never, PUBLIC_VIEWER, result.scope, siteConfig.entity.Plural,
  );
  if (!heading) return {};

  return {
    title: heading.title,
    robots: heading.isIndexable ? undefined : { index: false, follow: true },
  };
}
