import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ownerListing } from "@/lib/db/queries/owner";
import { ownerPhotoQuota, ownerPhotos } from "@/lib/db/queries/photos";
import { listingPhotosConfigured } from "@/lib/media/listing-photos";
import { mediaUrl } from "@/lib/media/public-url";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhotoManager } from "./PhotoManager";

export const metadata: Metadata = {
  title: "Photos",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function OwnerPhotosPage({ params }: Props) {
  const { id } = await params;
  const viewer = await currentViewer();

  // Null for a listing this viewer does not own, and the answer is a 404 —
  // not a 403 — for the same reason as the edit page.
  const listing = await ownerListing(db, viewer, id);
  if (!listing) notFound();

  const [photos, quota] = await Promise.all([
    ownerPhotos(db, viewer, listing.id),
    ownerPhotoQuota(db, viewer, listing.id),
  ]);
  if (!quota) notFound();

  const tier = siteConfig.tiers[listing.tier];

  return (
    <main>
      <PageHeader
        title="Photos"
        back={{ href: `/account/listings/${listing.id}`, label: listing.name }}
        lede={`The photos on ${listing.name}'s page. The first one is shown at the top; the rest below it.`}
      >
        <p>
          <a href={listing.path}>View the public page</a>
        </p>
      </PageHeader>

      <PhotoManager
        listingId={listing.id}
        photos={photos.map((p) => ({
          id: p.id,
          thumbUrl: mediaUrl(p.thumbPath),
          alt: p.alt ?? "",
          status: p.status,
        }))}
        used={quota.used}
        max={quota.max}
        tierLabel={tier.label}
        uploadsAvailable={listingPhotosConfigured()}
      />
    </main>
  );
}
