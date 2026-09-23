import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ownerEnquiries, ownerListing } from "@/lib/db/queries/owner";
import { EnquiryInbox } from "@/components/account/EnquiryInbox";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Enquiries",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function OwnerEnquiriesPage({ params }: Props) {
  const { id } = await params;
  const viewer = await currentViewer();

  const listing = await ownerListing(db, viewer, id);
  if (!listing) notFound();

  const enquiries = await ownerEnquiries(db, viewer, id);

  return (
    <main>
      <PageHeader
        title="Enquiries"
        back={{ href: `/account/listings/${listing.id}`, label: listing.name }}
        lede={`Messages sent to ${listing.name} through its page. Newest first.`}
      />

      <EnquiryInbox
        locale={siteConfig.locale}
        enquiries={enquiries.map((e) => ({
          id: e.id,
          createdAt: e.createdAt.toISOString(),
          name: e.name,
          email: e.email,
          phone: e.phone,
          message: e.message,
          read: e.readAt !== null,
          replied: e.repliedAt !== null,
        }))}
      />
    </main>
  );
}
