import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { guardFeature } from "@/lib/features/guard";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { reviewTarget } from "@/lib/db/queries/reviews";
import { ReviewForm } from "@/components/reviews/ReviewForm";
import { REVIEW_STEPS } from "@/components/reviews/steps";
import { PageHeader } from "@/components/ui/PageHeader";
import { Steps } from "@/components/ui/Steps";

/**
 * Where a review is written.
 *
 * Its own route rather than a form on the listing page: the invitation a
 * business sends a customer has to be a link to a page that is about writing
 * the review and nothing else, and a form buried under a listing's address and
 * photos is a form nobody fills in.
 *
 * Rendered per request. The page names a specific listing and says whether it
 * is still published; caching that would mean offering a review form for a
 * listing that was removed last week.
 */
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ listingId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { listingId } = await params;
  const target = await reviewTarget(db as never, PUBLIC_VIEWER, listingId);
  return {
    title: target ? `Review ${target.name}` : "Write a review",
    // A form page has nothing to offer a search result and would compete with
    // the listing page it is about.
    robots: { index: false, follow: true },
  };
}

export default async function LeaveReviewPage({ params }: Props) {
  guardFeature("reviews");

  const { listingId } = await params;
  const target = await reviewTarget(db as never, PUBLIC_VIEWER, listingId);
  if (!target) notFound();

  const e = siteConfig.entity;
  // Server-side env: the site key is public in the markup but is not a
  // NEXT_PUBLIC_ variable in this repo, so the page passes it down explicitly.
  const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY?.trim() || null;

  return (
    <main>
      <PageHeader
        title={`Review ${target.name}`}
        back={{ href: target.path, label: target.name }}
        lede={
          <>
            You&rsquo;re writing about <a href={target.path}>{target.name}</a>. We email you a
            link to confirm it is yours before anything is published.
          </>
        }
      />
      <Steps steps={REVIEW_STEPS} current={0} />

      <h2>Before you write</h2>
      <ul>
        <li>Review your own experience. We don&rsquo;t accept second-hand accounts.</li>
        <li>
          You can&rsquo;t review a {e.singular} you own or work for — and we check both the
          account and the address on the listing.
        </li>
        <li>
          We email you a link to confirm your address. Nothing appears until you click it, and
          reviews with links, contact details or abuse in them go to a person first.
        </li>
        <li>A critical review is published exactly as fast as a positive one.</li>
      </ul>

      <ReviewForm
        listingId={target.id}
        listingName={target.name}
        turnstileSiteKey={turnstileSiteKey}
      />
    </main>
  );
}
