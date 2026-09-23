import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { writeAudit } from "@/lib/db/queries/audit";
import { clientIp } from "@/lib/spam/client-ip";
import { emptySpotsReport } from "@/lib/spots/availability";
import { emptySpotsCsv } from "@/lib/spots/csv";
import { siteOrigin } from "@/lib/site-env";
import { now } from "@/lib/clock";
import type { TestDb } from "@/lib/db/types";

/**
 * GET /admin/spots/export — the empty spots as a CSV, for outreach.
 *
 * Under /admin so the layout's gate applies to the page that links it; the
 * handler re-checks the role itself (a route handler has no layout) and
 * answers 404, not 403, to anyone else — the same as the console's pages.
 * Every download is an audit row with the ip (constraint 22).
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (viewer.role !== "admin") return new Response(null, { status: 404 });

  const rows = await emptySpotsReport(db as unknown as TestDb, viewer);
  const csv = emptySpotsCsv(rows, siteOrigin());
  const count = csv.split("\r\n").length - 1;
  await writeAudit(db as unknown as TestDb, viewer, {
    action: "spots.export_downloaded",
    entityType: "featured_spot",
    meta: { rows: count },
    ip: clientIp(request.headers),
  });
  const day = now().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="empty-featured-spots-${day}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
