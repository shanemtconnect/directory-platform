import type { Metadata } from "next";
import { cookies } from "next/headers";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { guardFeature } from "@/lib/features/guard";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import {
  MAX_SHORTLIST_ITEMS,
  SHORTLIST_COOKIE,
  findShortlistByCookie,
  listShortlistEntries,
} from "@/lib/db/queries/shortlist";
import { ComparisonTable } from "@/components/shortlist/ComparisonTable";
import { RenameForm } from "@/components/shortlist/RenameForm";
import { ShareControls } from "@/components/shortlist/ShareControls";

// One visitor's saved list. There is nothing here for a crawler: the content is
// per-cookie, and an indexed shortlist would be a thin near-duplicate of the
// listings it points at. noindex,follow — the links themselves are worth following.
export const metadata: Metadata = {
  title: "Your shortlist",
  robots: { index: false, follow: true },
};

// Reads a cookie, so it can never be cached or statically rendered.
export const dynamic = "force-dynamic";

export default async function ShortlistPage() {
  guardFeature("shortlist");

  const e = siteConfig.entity;
  const cookieId = (await cookies()).get(SHORTLIST_COOKIE)?.value ?? "";
  const list = cookieId
    ? await findShortlistByCookie(db as never, PUBLIC_VIEWER, cookieId)
    : null;
  // A saved listing that has since been unpublished or deleted is filtered out
  // by the query rather than 404ing the page around it.
  const entries = list
    ? await listShortlistEntries(db as never, PUBLIC_VIEWER, list.id)
    : [];

  if (!list || entries.length === 0) {
    return (
      <main>
        <h1>Your shortlist</h1>
        <p data-testid="shortlist-empty">
          You haven&rsquo;t saved anything yet. Save up to {MAX_SHORTLIST_ITEMS}{" "}
          {e.plural} and compare them side by side — no account needed.
        </p>
        <p>
          <a href="/search">Search {e.plural}</a> or{" "}
          <a href="/cities">browse by location</a>.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1 data-testid="shortlist-heading">{list.name ?? "Your shortlist"}</h1>
      <p>
        Saved on this device. {entries.length} of {MAX_SHORTLIST_ITEMS} saved.
      </p>

      <RenameForm name={list.name} />

      <ComparisonTable entries={entries} mode="own" />

      <ShareControls shareId={list.shareId} isPublic={list.isPublic} />
    </main>
  );
}
