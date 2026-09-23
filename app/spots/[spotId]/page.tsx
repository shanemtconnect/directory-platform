import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { spotLeaderboard, type SpotLeaderboard } from "@/lib/db/queries/spots";
import { isUuid } from "@/lib/actions/validation";
import { PageHeader } from "@/components/ui/PageHeader";
import type { TestDb } from "@/lib/db/types";

/**
 * `/spots/[spotId]` — the public leaderboard for one featured spot (Task 45).
 *
 * Who holds each position and how many are taken; never what anybody bid.
 * Linked from the Featured row's "How this works" and from the owner's
 * bidding page. Per request rather than cached: it changes with every bid
 * and nothing links it for crawlers to find — it is `noindex`.
 */

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ spotId: string }>;
}

const e = siteConfig.entity;

async function load(spotId: string): Promise<SpotLeaderboard | null> {
  if (!isUuid(spotId)) return null;
  const board = await spotLeaderboard(db as unknown as TestDb, PUBLIC_VIEWER, spotId);
  // A closed spot has no ranking to show; it is not a page.
  return board !== null && board.spot.status === "closed" ? null : board;
}

function titleFor(board: SpotLeaderboard): string {
  return board.categoryName === null
    ? `Featured ${e.plural} in ${board.areaName}`
    : `Featured ${e.plural} for ${board.categoryName} in ${board.areaName}`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { spotId } = await params;
  const board = await load(spotId);
  return {
    title: board === null ? "Featured spot" : titleFor(board),
    robots: { index: false, follow: false },
  };
}

export default async function SpotLeaderboardPage({ params }: Props) {
  const { spotId } = await params;
  const board = await load(spotId);
  if (board === null) notFound();

  const { spot } = board;
  const filled = board.featured.length;
  const byPosition = new Map(board.featured.map((f) => [f.position, f]));
  const positions = Array.from({ length: spot.positions }, (_, i) => i + 1);
  const pageLabel = board.categoryName === null ? board.areaName : `${board.categoryName} in ${board.areaName}`;

  return (
    <main data-testid="spot-leaderboard">
      <PageHeader
        title={titleFor(board)}
        lede={`The ${spot.positions} highest monthly bids are shown above every ${e.singular} listed on this page. ${filled} of ${spot.positions} taken.`}
        {...(board.path === null ? {} : { back: { href: board.path, label: pageLabel } })}
      />

      <p data-testid="spot-scarcity">
        <strong>{filled} of {spot.positions} taken.</strong>
      </p>

      <ol data-testid="spot-positions" className="list-none p-0">
        {positions.map((position) => {
          const holder = byPosition.get(position);
          return (
            <li key={position} data-position={position} className="card mb-2 flex items-center gap-4">
              <span className="font-heading text-2xl font-semibold" aria-label={`Position ${position}`}>#{position}</span>
              {holder === undefined ? (
                <span className="text-muted" data-testid="spot-open">Open</span>
              ) : (
                <a href={`/${holder.citySlug}/${holder.slug}`} className="font-semibold">{holder.name}</a>
              )}
            </li>
          );
        })}
      </ol>

      <section aria-labelledby="how" className="prose">
        <h2 id="how">How featured spots work</h2>
        <p>
          Owners of Verified {e.plural} on a paid plan bid a monthly amount for a spot. The {spot.positions} highest
          bids are featured, in order; anyone outbid keeps their ordinary place in the list and pays nothing for the
          spot. Positions change as bids do, so what you see here is the ranking right now.
        </p>
        <p>
          Own a {e.singular} listed here? <a href="/account">Bid from your account</a>. Not listed yet?{" "}
          <a href="/add-listing">Add your {e.singular}</a>.
        </p>
      </section>
    </main>
  );
}
