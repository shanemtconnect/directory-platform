import { after } from "next/server";
import { siteConfig } from "@/config/site.config";
import { badgeListing } from "@/lib/db/queries/badges";
import { db } from "@/lib/db/client";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { awardYearOfStyle, DEFAULT_BADGE_STYLE, parseBadgeStyle, renderBadgeSvg } from "@/lib/badge/svg";
import { recordBadgeImpression } from "@/lib/badge/counters";
import { features } from "@/lib/features/flags";
import { hasAwardForYear } from "@/lib/db/queries/awards";

/**
 * GET /badge/{listingId}?style=dark|light|compact|rating
 *
 * Served to third-party websites, so it is deliberately dumb: no cookies and
 * no session. It reads one published row as the public viewer and renders an
 * image.
 *
 * Cached for 24h. The badge changes only when a listing is renamed or its
 * claim status moves, neither of which is urgent enough to pay for a database
 * hit on every impression across every site that embeds it.
 */

export const dynamic = "force-dynamic";

const CACHE = "public, max-age=86400, s-maxage=86400";

function notFound(): Response {
  // 404s are cached briefly so a hotlinked dead badge does not hammer the db.
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  let style = parseBadgeStyle(new URL(request.url).searchParams.get("style"));

  // An award style is a claim, and the `awards` table is the only thing that
  // can back it: a listing that did not win that year — or whose award was
  // revoked, or on a site without the module — gets the default badge, not a
  // winner's. Silently, and cached like any other: a wrong style is a wrong
  // query string, not an error the embedding site can act on.
  const awardYear = awardYearOfStyle(style);
  if (awardYear !== null) {
    const won = features.awards && (await hasAwardForYear(db as never, PUBLIC_VIEWER, id, awardYear));
    if (!won) style = DEFAULT_BADGE_STYLE;
  }

  // Published only, and the query is the thing that enforces it: an
  // unpublished, rejected or removed listing must not be able to display a
  // badge on someone else's website.
  const row = await badgeListing(db as never, PUBLIC_VIEWER, id);
  if (!row) return notFound();

  // Counted in Redis and folded into `badges.impression_count` by the worker
  // once a minute. One UPDATE per impression would mean a row lock on every
  // page view of every site that ever pasted the snippet — the one traffic
  // shape this application does not control. Deferred past the response, and
  // swallowing its own errors: the image renders whether or not the cache is
  // reachable.
  after(() => {
    void recordBadgeImpression(row.id).catch(() => {});
  });

  const svg = renderBadgeSvg({
    siteName: siteConfig.name,
    listingName: row.name,
    style,
    // Verified is the claim status and nothing else. A paid tier alone is not
    // verification, and inferring it from tier would make the badge a lie.
    verified: row.claimStatus === "verified",
    ratingAvg: row.ratingAvg,
    ratingCount: row.ratingCount,
  });

  return new Response(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": CACHE,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      // Embedded cross-origin by design.
      "Access-Control-Allow-Origin": "*",
    },
  });
}
