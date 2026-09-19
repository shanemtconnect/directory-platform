import { db } from "@/lib/db/client";
import { siteUrl } from "@/lib/schema/builders";
import { isStaging } from "@/lib/site-env";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { countSitemapListings, sitemapShardIds, shardPath } from "@/lib/db/queries/sitemap";

/**
 * The sitemap INDEX.
 *
 * Next's `generateSitemaps` publishes the shards (app/sitemaps/sitemap.ts) but
 * does not generate an index for them, so without this /sitemap.xml — the URL
 * robots.txt advertises and the one every crawler and every operator tries
 * first — would 404 and none of the shards would ever be discovered.
 *
 * Escaping: shard ids are generated here from a fixed vocabulary, so the only
 * caller-influenced part of a <loc> is the origin. `&` is still escaped because
 * an unescaped one makes the whole document unparseable, and a sitemap that
 * fails to parse is silently ignored.
 */
export const dynamic = "force-dynamic";

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function GET(): Promise<Response> {
  // A staging site advertises nothing: an empty but valid index.
  const ids = isStaging()
    ? []
    : sitemapShardIds(await countSitemapListings(db as never, PUBLIC_VIEWER));

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + ids.map((id) => `  <sitemap><loc>${escapeXml(siteUrl(shardPath(id)))}</loc></sitemap>\n`).join("")
    + `</sitemapindex>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600",
    },
  });
}
