import { db } from "@/lib/db/client";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { recordUnsubscribe } from "@/lib/db/queries/unsubscribes";
import { deactivateSavedSearch } from "@/lib/db/queries/saved-searches";
import { isSavedSearchClaim, verifyUnsubscribe } from "@/lib/email/unsubscribe";
import { clientIp } from "@/lib/spam/client-ip";
import { UNSUBSCRIBE_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import type { Db } from "@/lib/db/client";

/**
 * POST /unsubscribe/confirm — the button on the landing page.
 *
 * POST only: a GET here would let a link-following scanner opt somebody out.
 * The token is verified again — the page's check was for the sentence on
 * the screen, this one is for the write.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const limit = await limitPublicWrite("unsubscribe", request.headers, UNSUBSCRIBE_RATE_LIMIT);
  if (!limit.allowed) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "no-store" },
    });
  }

  const form = await request.formData();
  const token = form.get("t");
  const claim = verifyUnsubscribe(typeof token === "string" ? token : null);
  if (claim === null) {
    return new Response("That link is not one we recognise.", { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const ip = clientIp(request.headers);

  // A saved-search digest (Task 54): that one search stops, nothing else —
  // and only while the token's address is still the owner's (an old address
  // after an email change cannot). Not behind the savedSearches flag: a link
  // already sent keeps working.
  if (isSavedSearchClaim(claim)) {
    await db.transaction(async (tx) =>
      deactivateSavedSearch(tx as unknown as Db, PUBLIC_VIEWER, claim.savedSearchId, claim.email, ip),
    );
    return Response.redirect(new URL("/unsubscribe?done=alerts", request.url), 303);
  }

  await db.transaction(async (tx) =>
    recordUnsubscribe(tx as unknown as Db, PUBLIC_VIEWER, {
      email: claim.email, listingId: claim.listingId, reason: "quote", ip,
    }),
  );

  // 303, so the browser follows with a GET and the back button cannot resubmit.
  return Response.redirect(new URL("/unsubscribe?done=1", request.url), 303);
}
