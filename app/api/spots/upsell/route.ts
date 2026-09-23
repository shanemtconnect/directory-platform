import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { upsellCandidate, type SpotKey } from "@/lib/db/queries/spots";
import { isUuid } from "@/lib/actions/validation";
import type { TestDb } from "@/lib/db/types";

/**
 * GET /api/spots/upsell?key=<areaKind:areaId:categoryId|->
 *
 * The one authenticated fetch behind the pillar page's upsell strip (Task
 * 45, requirement 6). The pillar page is ISR-cached, so nothing about the
 * signed-in visitor can be rendered into it; the strip asks here from the
 * browser instead. 204 for everyone it has nothing to say to — anonymous
 * visitors first of all, decided from the cookie header before any session
 * lookup — so the request costs a crawler or a stranger nothing.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function nothing(): Response {
  return new Response(null, { status: 204, headers: NO_STORE });
}

export function parseKey(raw: string | null): SpotKey | null {
  if (raw === null) return null;
  const parts = raw.split(":");
  if (parts.length !== 3) return null;
  const [areaKind, areaId, category] = parts as [string, string, string];
  if (areaKind !== "city" && areaKind !== "region") return null;
  if (areaKind === "city" ? !isUuid(areaId) : !/^[a-z0-9-]{1,120}$/.test(areaId)) return null;
  if (category !== "-" && !isUuid(category)) return null;
  return { areaKind, areaId, categoryId: category === "-" ? null : category };
}

export async function GET(request: Request): Promise<Response> {
  const key = parseKey(new URL(request.url).searchParams.get("key"));
  if (key === null) {
    return new Response("Bad request", { status: 400, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
  }
  // No session cookie, no session: answer before touching the database.
  if (!(request.headers.get("cookie") ?? "").includes("session_token")) return nothing();

  const viewer = await currentViewer();
  if (viewer.role === "public") return nothing();
  const profile = await ensureProfile(db, viewer);
  const candidate = await upsellCandidate(db as unknown as TestDb, viewer, profile.id, key);
  if (candidate === null) return nothing();
  return Response.json(
    {
      listingId: candidate.listingId,
      listingName: candidate.listingName,
      fromCents: candidate.fromCents,
      href: `/account/listings/${candidate.listingId}/featured`,
    },
    { headers: NO_STORE },
  );
}
