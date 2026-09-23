import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { listCities } from "@/lib/db/queries/indexes";
import { jobPostingIsFree, posterListings, type PosterListing } from "@/lib/db/queries/job-board";
import { submissionOptions } from "@/lib/db/queries/submissions";
import { guardFeature } from "@/lib/features/guard";
import { PostJobForm } from "@/components/jobs/PostJobForm";
import { formatJobPrice } from "@/components/jobs/format";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Post a job",
  description: `Post a vacancy to ${siteConfig.name}. Free for Verified ${siteConfig.entity.plural}; ${formatJobPrice()} for everyone else.`,
};

/**
 * Per request: the town and category selects come from the database, and
 * the free-or-paid answer depends on who is signed in. No login wall — a
 * stranger can pay and post — but a signed-in owner of a Verified listing
 * gets the picker and no price.
 */
export const dynamic = "force-dynamic";

export default async function PostAJobPage() {
  guardFeature("jobBoard");
  const e = siteConfig.entity;
  const viewer = await currentViewer();

  const [cities, options] = await Promise.all([
    listCities(db, PUBLIC_VIEWER, { onlyIndexable: false }),
    submissionOptions(db, PUBLIC_VIEWER),
  ]);

  let listings: PosterListing[] = [];
  if (viewer.role !== "public") {
    const profile = await ensureProfile(db, viewer);
    listings = await posterListings(db, viewer, profile.id);
  }

  const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY?.trim() || null;

  return (
    <main>
      <div className="mx-auto max-w-2xl">
        <PageHeader
          title="Post a job"
          lede={`Vacancies on ${siteConfig.name} are read by hand before they go live, stay up for ${siteConfig.jobs.durationDays} days, and take applications by email or on your own site.`}
        />
        <ul>
          <li>Owners of a Verified {e.singular} post free. Everyone else pays {formatJobPrice()} per post.</li>
          <li>We publish real vacancies only. Agencies may post, but the employer must be named.</li>
          <li>Applications go straight to you. We never see or keep them.</li>
        </ul>
        <PostJobForm
          cities={cities.map((c) => ({ id: c.id, name: c.name, region: c.region }))}
          categories={options.categories}
          listings={listings}
          signedIn={viewer.role !== "public"}
          charges={!jobPostingIsFree()}
          turnstileSiteKey={turnstileSiteKey}
        />
      </div>
    </main>
  );
}
