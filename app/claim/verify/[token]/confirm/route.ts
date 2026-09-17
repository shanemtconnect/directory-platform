import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { verifyClaimToken } from "@/lib/db/queries/claims";
import { CLAIM_VERIFY_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import { clientIp } from "@/lib/spam/client-ip";
import type { Db } from "@/lib/db/client";

/**
 * POST /claim/verify/<token>/confirm — the button on the landing page.
 *
 * POST only, deliberately. This is the request that changes who owns a
 * listing, and the one thing standing between a mail-security scanner and a
 * completed takeover is that scanners issue GETs. There is no GET export here:
 * anything that follows the URL without submitting the form gets a 405.
 *
 * Everything ends at /account. The link is usually opened in a different
 * browser from the one that started the claim, so the sign-in that /account
 * demands is the confirmation that the right person arrived; the claim itself
 * is already applied by then.
 */

export const dynamic = "force-dynamic";

function back(request: Request, outcome: string): Response {
  const url = new URL(`/account?claim=${outcome}`, request.url);
  // 303, so the browser follows with a GET and the back button cannot resubmit.
  return Response.redirect(url, 303);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  // One bucket with the landing page: a guess loop against either is the
  // same loop, and a real claimant spends two of the thirty.
  const limit = await limitPublicWrite("claim-verify", request.headers, CLAIM_VERIFY_RATE_LIMIT);
  if (!limit.allowed) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "no-store" },
    });
  }

  const { token } = await params;
  const viewer = await currentViewer();

  // The address goes on the claim.approved audit row, as it does for every
  // other claim decision: a takeover investigated later is worth nothing
  // without where the confirming click came from.
  const ip = clientIp(request.headers);

  const result = await db.transaction(async (tx) =>
    verifyClaimToken(tx as unknown as Db, viewer, decodeURIComponent(token), ip),
  );

  if (result.outcome !== "approved") return back(request, result.outcome);

  // The listing page is ISR-cached and now says something different about who
  // owns it. Without this the change is invisible until the cache turns over.
  revalidatePath(result.path);
  return back(request, "approved");
}
