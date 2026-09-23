import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ownerListing } from "@/lib/db/queries/owner";
import { ownerQuoteLeads } from "@/lib/db/queries/quotes";
import { LeadsInbox } from "@/components/quotes/LeadsInbox";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Quote requests",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Quote requests sent to one listing. Not behind the feature flag: a clone
 * that turns quoteBroadcast off later still owes its owners the requests
 * that arrived while it was on, and an empty inbox says so plainly.
 */
export default async function OwnerLeadsPage({ params }: Props) {
  const { id } = await params;
  const viewer = await currentViewer();

  const listing = await ownerListing(db, viewer, id);
  if (!listing) notFound();

  const leads = await ownerQuoteLeads(db, viewer, id);

  return (
    <main>
      <PageHeader
        title="Quote requests"
        back={{ href: `/account/listings/${listing.id}`, label: listing.name }}
        lede={`Requests for quotes sent to ${listing.name} from the get-quotes page. Newest first.`}
      />

      <LeadsInbox
        locale={siteConfig.locale}
        leads={leads.map((l) => ({
          id: l.id,
          createdAt: l.createdAt.toISOString(),
          cityName: l.cityName,
          categoryName: l.categoryName,
          outcome: l.outcome,
          contactVisible: l.contactVisible,
          job: l.job,
          requester: l.requester,
        }))}
      />
    </main>
  );
}
