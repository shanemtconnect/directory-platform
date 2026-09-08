import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { listings } from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import { parseBadgeStyle, renderBadgeSvg } from "@/lib/badge/svg";

/**
 * GET /badge/{listingId}?style=dark|light|compact|rating
 *
 * Served to third-party websites, so it is deliberately dumb: no cookies, no
 * session, no viewer. It reads one published row and renders an image.
 *
 * Cached for 24h. The badge changes only when a listing is renamed or its
 * claim status moves, neither of which is urgent enough to pay for a database
 * hit on every impression across every site that embeds it.
 */

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!UUID.test(id)) return notFound();

  const style = parseBadgeStyle(new URL(request.url).searchParams.get("style"));

  const [row] = await db
    .select({
      name: listings.name,
      claimStatus: listings.claimStatus,
      ratingAvg: listings.ratingAvg,
      ratingCount: listings.ratingCount,
    })
    .from(listings)
    // Published only. An unpublished, rejected or removed listing must not be
    // able to display a badge on someone else's website.
    .where(and(eq(listings.id, id), eq(listings.status, "published")))
    .limit(1);

  if (!row) return notFound();

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
