import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { loginPath } from "@/lib/auth/next";
import { claimableDomain } from "@/lib/claims/domain";
import { ownerBadgeStatus } from "@/lib/db/queries/badge-owner";
import { ownerListings } from "@/lib/db/queries/owner";
import { BadgeGallery } from "@/components/advertise/BadgeGallery";
import { BacklinkForm } from "@/components/advertise/BacklinkForm";
import { BacklinkStatus } from "@/components/advertise/BacklinkStatus";

export const metadata: Metadata = {
  title: "Your badge",
  robots: { index: false, follow: false },
};

const PUBLIC_PAGE = "/advertise/badge";
const THIS_PAGE = "/advertise/badge/mine";

/**
 * The owner's half of the badge page.
 *
 * Split out of /advertise/badge so that page can be static: it read
 * `searchParams`, which makes a route dynamic in Next 16, and its
 * `revalidate = 3600` had been a dead export since. Everything per-viewer —
 * the session, the real listing id in the snippet, where the badge was put
 * and what the last check found — lives here, per request, and the public
 * page keeps its worked example and its cache.
 *
 * Nothing here decides who owns what. `ownerBadgeStatus` scopes by the
 * viewer inside the query (constraint 24); a listing that does not come back
 * is treated as "not yours" and answered with the public page rather than a
 * 404, which would confirm the row exists.
 */
export default async function MyBadgePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[] }>;
}) {
  const params = await searchParams;
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const here = id ? `${THIS_PAGE}?id=${id}` : THIS_PAGE;

  const viewer = await currentViewer();
  if (viewer.role === "public") redirect(loginPath(here));
  await ensureProfile(db, viewer);

  const e = siteConfig.entity;

  if (!id) {
    const owned = await ownerListings(db, viewer);
    return (
      <main>
        <p className="text-sm text-muted"><a href={PUBLIC_PAGE}>← About the badge</a></p>
        <h1>Your badge</h1>
        {owned.length === 0 ? (
          <p data-testid="no-listings">
            You do not own a listing here yet. Claim your {e.singular} from{" "}
            <a href="/account">your account</a> and the badge code will be waiting for you.
          </p>
        ) : (
          <>
            <p>Which listing is the badge for?</p>
            <ul data-testid="badge-listing-picker">
              {owned.map((l) => (
                <li key={l.id}>
                  <a href={`${THIS_PAGE}?id=${l.id}`}>{l.name}</a>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    );
  }

  const status = await ownerBadgeStatus(db, viewer, id);
  if (!status) redirect(PUBLIC_PAGE);

  return (
    <main>
      <p className="text-sm text-muted">
        <a href="/account">← Your account</a>
        {" · "}
        <a href={PUBLIC_PAGE}>About the badge</a>
      </p>
      <h1>Your {siteConfig.name} badge</h1>
      <p>
        <strong>This is the badge for {status.name}.</strong> The code below is yours — it
        already points at <a href={status.path}>your listing</a>.
      </p>

      <h2>Where is it?</h2>
      <p>
        Tell us the page you pasted it on and we will go and look for the link. While the link
        is there, your listing ranks a little higher; if it disappears, so does that.
      </p>
      <BacklinkStatus status={status} />
      <BacklinkForm
        listingId={status.id}
        currentUrl={status.backlinkUrl}
        expectedDomain={claimableDomain(status.website)}
      />

      <h2>The four styles</h2>
      <p>
        Each style comes with two versions of the same code: the plain one, whose badge links
        straight to your listing, and a tracked one that routes the click through us so the
        count is visible to you — at the cost of a <code>nofollow</code> on the link. The plain
        one is the default because the link is the point.
      </p>
      <BadgeGallery
        base={{
          listingId: status.id,
          listingName: status.name,
          listingPath: status.path,
          cityName: status.cityName,
          categoryName: status.categoryName ?? e.Singular,
        }}
        verified={status.claimStatus === "verified"}
        ratingAvg={status.ratingAvg}
        ratingCount={status.ratingCount}
      />

      <p>
        The rules and the reasoning are on <a href={PUBLIC_PAGE}>the badge page</a>.
      </p>
    </main>
  );
}
