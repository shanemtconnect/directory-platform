import type { listings as listingsTable } from "@/lib/db/schema";
import type { PillarHeading } from "@/lib/db/queries/cities";
import { siteConfig } from "@/config/site.config";
import { Pagination } from "./Pagination";

type Listing = typeof listingsTable.$inferSelect;

interface Props {
  heading: PillarHeading;
  listings: Listing[];
  page: number;
  totalPages: number;
  basePath: string;
}

/**
 * One component for all four PillarScope shapes. Phase 2 adds the featured row,
 * filters, map, category sub-links, nearby cities and FAQ; this is the skeleton
 * that proves the scope abstraction reaches the page.
 */
export function PillarPage({ heading, listings, page, totalPages, basePath }: Props) {
  const e = siteConfig.entity;
  return (
    <main>
      <h1>{heading.title}</h1>

      {heading.introHtml && (
        <div dangerouslySetInnerHTML={{ __html: heading.introHtml }} />
      )}

      {listings.length === 0 ? (
        <p>No {e.plural} listed in {heading.place} yet.</p>
      ) : (
        <ul data-testid="listing-grid">
          {listings.map((l) => (
            <li key={l.id} data-tier={l.tier} data-claim-status={l.claimStatus}>
              <a href={`${basePath}/${l.slug}`}>{l.name}</a>
              {l.claimStatus === "unclaimed" && <span> · Unverified</span>}
              {l.claimStatus === "verified" && <span> · Verified</span>}
              {l.shortDescription && <p>{l.shortDescription}</p>}
            </li>
          ))}
        </ul>
      )}

      <Pagination basePath={basePath} page={page} totalPages={totalPages} />

      <p>
        Own a {e.singular} in {heading.place}?{" "}
        <a href="/add-listing">Add it free.</a>
      </p>
    </main>
  );
}
