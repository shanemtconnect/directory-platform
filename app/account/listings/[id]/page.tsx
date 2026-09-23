import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ownerListing } from "@/lib/db/queries/owner";
import { listingStats } from "@/lib/db/queries/stats";
import { ListingEditor } from "@/components/account/ListingEditor";
import { ListingStats } from "@/components/stats/ListingStats";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Edit your listing",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

/** jsonb, so it can be anything. Only a genuine list of strings is a list. */
function socialLines(socials: unknown): string {
  if (!Array.isArray(socials)) return "";
  return socials.filter((s): s is string => typeof s === "string").join("\n");
}

function hoursRecord(hours: unknown): Record<string, string> {
  if (typeof hours !== "object" || hours === null || Array.isArray(hours)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(hours as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export default async function EditListingPage({ params }: Props) {
  const { id } = await params;
  const viewer = await currentViewer();

  // Null for a listing this viewer does not own, and the answer is a 404 —
  // not a 403. "You may not edit this" confirms the row exists and is
  // somebody's; a 404 says nothing at all.
  const listing = await ownerListing(db, viewer, id);
  if (!listing) notFound();

  const tier = siteConfig.tiers[listing.tier];

  // The ROI panel. `listingStats` carries its own owner gate (constraint 24)
  // and caps the window at the tier's own; the page asks for the whole of that
  // window and lets the query say how much of it this tier may see. A refusal
  // here can only mean the ownership changed between the two reads, and the
  // answer is the same 404 as above.
  const stats = await listingStats(db, viewer, listing.id, tier.statsWindowDays);
  if (!stats) notFound();

  return (
    <main>
      <PageHeader
        title={listing.name}
        back={{ href: "/account", label: "Your account" }}
        lede={`Edit what the public page says, then see how the ${siteConfig.entity.singular} is doing below.`}
      >
        <p className="flex flex-wrap gap-1">
          <span className={listing.status === "published" ? "pill pill-on" : "pill"}>
            {listing.status === "published" ? "Live" : `Status: ${listing.status}`}
          </span>
          <span className={listing.tier === "free" ? "pill" : "pill pill-primary"}>{tier.label}</span>
          {listing.claimStatus === "verified" && <span className="pill pill-on">Verified</span>}
        </p>
        <p>
          <a href={listing.path}>View the public page</a>
          {" · "}
          <a href={`/account/listings/${listing.id}/enquiries`}>Enquiries</a>
          {" · "}
          <a href={`/account/listings/${listing.id}/photos`} data-testid="photos-link">Photos</a>
          {" · "}
          <a href={`/account/listings/${listing.id}/leads`} data-testid="leads-link">Quote requests</a>
          {" · "}
          <a href={`/advertise/badge/mine?id=${listing.id}`} data-testid="badge-link">Get your badge</a>
        </p>
      </PageHeader>

      <ListingEditor
        listingId={listing.id}
        description={listing.description ?? ""}
        phone={listing.phone ?? ""}
        website={listing.website ?? ""}
        socials={socialLines(listing.socials)}
        openingHours={hoursRecord(listing.openingHours)}
        maxDescriptionChars={siteConfig.listing.maxDescriptionChars}
        showsWebsite={tier.showWebsite}
        showsSocial={tier.showSocial}
      />

      <ListingStats stats={stats} headingLevel="h2" />
    </main>
  );
}
