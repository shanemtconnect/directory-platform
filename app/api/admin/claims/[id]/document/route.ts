import { headers } from "next/headers";
import { db } from "@/lib/db/client";
import { ensureProfile } from "@/lib/auth/profile";
import { requireAdmin } from "@/lib/auth/viewer";
import { claimDocumentKey, recordDocumentView } from "@/lib/db/queries/claims";
import { claimDocsConfigured, presignClaimDocView } from "@/lib/media/claim-docs";
import { clientIp } from "@/lib/spam/client-ip";
import type { Db } from "@/lib/db/client";

/**
 * GET /api/admin/claims/<id>/document?slot=proof|id
 *
 * The ONLY way a claim document is ever read.
 *
 * The object lives in a private bucket with no public URL, so this route signs
 * a fifteen-minute GET and redirects to it. Three things make that safe rather
 * than a hole: the admin check is here and not merely on the page that links to
 * it; every presign writes an `audit_log` row, so who looked at somebody's
 * utility bill and when is a matter of record; and the signed URL is minted per
 * view rather than stored, so a link that leaks stops working within the
 * quarter of an hour an admin needs to read a PDF.
 */

export const dynamic = "force-dynamic";

function refuse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let viewer;
  try {
    viewer = await requireAdmin();
  } catch {
    // 404 rather than 403, for the same reason /admin 404s a signed-in
    // non-admin: confirming the route exists tells an attacker where to aim.
    return refuse(404, "Not found");
  }

  const { id } = await params;
  const slot = new URL(request.url).searchParams.get("slot") === "id" ? "id" : "proof";

  if (!claimDocsConfigured()) {
    return refuse(503, "Document storage is not configured on this site.");
  }

  const key = await claimDocumentKey(db, viewer, id, slot);
  if (key === null) return refuse(404, "Not found");

  const requestHeaders = await headers();
  // Written BEFORE the URL is handed over. An audit row that depends on the
  // signing call succeeding is an audit row that is missing exactly when
  // something went wrong.
  await db.transaction(async (tx) => {
    const handle = tx as unknown as Db;
    const profile = await ensureProfile(handle, viewer);
    await recordDocumentView(handle, viewer, {
      claimId: id,
      actorProfileId: profile.id,
      slot,
      ip: clientIp(requestHeaders),
    });
  });

  let url: string;
  try {
    url = await presignClaimDocView(key);
  } catch {
    return refuse(503, "The document could not be opened.");
  }

  // 302, and never cached: the target expires, and a cached redirect would
  // outlive it and also skip the audit row on the next view.
  return new Response(null, {
    status: 302,
    headers: { Location: url, "Cache-Control": "no-store" },
  });
}
