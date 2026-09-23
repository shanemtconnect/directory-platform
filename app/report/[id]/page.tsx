import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { trustTarget } from "@/lib/db/queries/trust";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { ReportForm } from "@/components/trust/ReportForm";

export const metadata: Metadata = {
  title: "Report incorrect information",
  description: "Tell us what is wrong with a listing and we will fix it.",
  // Nothing here belongs in a search result: it is a form about one listing,
  // and indexing it would compete with the listing's own page.
  robots: { index: false, follow: true },
};

/**
 * The route /trust and /data-sources both promise.
 *
 * Per request rather than cached: the page names a listing by id, and a form
 * that offers to correct a listing which has since been taken down should 404
 * rather than serve a cached name from a page nobody can see any more.
 */
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ReportPage({ params }: Props) {
  const { id } = await params;
  const listing = await trustTarget(db, PUBLIC_VIEWER, id);
  // Behind the published-only gate, so an id in a URL cannot be used to probe
  // whether an unpublished listing exists.
  if (!listing) notFound();

  return (
    <main>
      <h1>Report incorrect information</h1>

      <p>
        You are telling us about <a href={listing.path}>{listing.name}</a>. Corrections are free
        and you don&rsquo;t need an account — we&rsquo;d rather fix a listing than leave it
        wrong.
      </p>

      <ReportForm
        listingId={listing.id}
        listingName={listing.name}
        // Server-side env: the site key is public in the markup, but it is not
        // a NEXT_PUBLIC_ variable in this repo, so the page passes it down.
        turnstileSiteKey={process.env.TURNSTILE_SITE_KEY?.trim() || null}
      />

      <p className="mt-6">
        <small>
          Want the listing taken down instead? <a href={`/remove/${listing.id}`}>Ask us to
          remove it</a>. Anything else:{" "}
          <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
        </small>
      </p>
    </main>
  );
}
