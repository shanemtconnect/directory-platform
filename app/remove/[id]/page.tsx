import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { trustTarget } from "@/lib/db/queries/trust";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { RemovalForm } from "@/components/trust/RemovalForm";
import { REMOVAL_SLA_WORKING_DAYS } from "@/lib/trust/working-days";

export const metadata: Metadata = {
  title: "Request removal",
  description: `Ask us to take a listing down. We action requests within ${REMOVAL_SLA_WORKING_DAYS} working days.`,
  robots: { index: false, follow: true },
};

/** Per request, for the same reason as /report/[id]. */
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function RemovePage({ params }: Props) {
  const { id } = await params;
  const listing = await trustTarget(db, PUBLIC_VIEWER, id);
  if (!listing) notFound();

  return (
    <main>
      <h1>Request removal</h1>

      <p>
        You are asking us to take down <a href={listing.path}>{listing.name}</a>. You do not
        need to give a reason.
      </p>

      <p>
        We action removal requests within <strong>{REMOVAL_SLA_WORKING_DAYS} working days</strong>,
        and we email you when it is done. When we remove a listing we also record enough to stop a
        later update putting it back, so you never have to ask twice.
      </p>

      <RemovalForm
        listingId={listing.id}
        listingName={listing.name}
        turnstileSiteKey={process.env.TURNSTILE_SITE_KEY?.trim() || null}
      />

      <p className="mt-6">
        <small>
          Is the listing yours and just wrong? <a href={`/report/${listing.id}`}>Send a
          correction</a> instead and we will fix it. Anything else:{" "}
          <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
        </small>
      </p>
    </main>
  );
}
