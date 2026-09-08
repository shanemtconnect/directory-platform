import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { guardFeature } from "@/lib/features/guard";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import {
  findPublicShortlistByShareId,
  listShortlistEntries,
} from "@/lib/db/queries/shortlist";
import { ComparisonTable } from "@/components/shortlist/ComparisonTable";

interface Props {
  params: Promise<{ shareId: string }>;
}

/**
 * A shared list is user-generated and, by construction, a near-duplicate of
 * pages we already want ranked — the listings it points at. Indexing it would
 * put thin, unowned pages into competition with the pillar pages that earn the
 * traffic, and every visitor who shares a link would mint another one.
 *
 * noindex,nofollow, and it is not in the sitemap. The `follow` is off as well
 * as the index, because there is no crawl path here worth spending budget on
 * that the pillar pages do not already provide.
 */
const ROBOTS = { index: false, follow: false, nocache: true } as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // No guard here: generateMetadata must not throw notFound() out from under
  // the page, and the page itself is the gate.
  const { shareId } = await params;
  const list = await findPublicShortlistByShareId(db as never, PUBLIC_VIEWER, shareId);
  return {
    title: list?.name ?? "Shared shortlist",
    robots: ROBOTS,
  };
}

// isPublic can be revoked at any moment, and a cached copy of a list the owner
// has just made private is exactly the failure this must not have.
export const dynamic = "force-dynamic";

export default async function SharedShortlistPage({ params }: Props) {
  guardFeature("shortlist");

  const { shareId } = await params;

  // isPublic is part of the lookup, so a correct-but-private shareId is
  // indistinguishable from a wrong one: both 404.
  const list = await findPublicShortlistByShareId(db as never, PUBLIC_VIEWER, shareId);
  if (!list) notFound();

  const e = siteConfig.entity;
  const entries = await listShortlistEntries(db as never, PUBLIC_VIEWER, list.id);

  return (
    <main>
      <h1 data-testid="shared-shortlist-heading">{list.name ?? "Shared shortlist"}</h1>
      <p>
        Someone shared this list of {e.plural} with you.{" "}
        <a href="/shortlist">Start your own shortlist</a>.
      </p>

      {entries.length === 0 ? (
        <p data-testid="shared-shortlist-empty">
          Nothing on this list is available any more.{" "}
          <a href="/search">Search {e.plural}</a> instead.
        </p>
      ) : (
        <ComparisonTable entries={entries} mode="shared" />
      )}
    </main>
  );
}
