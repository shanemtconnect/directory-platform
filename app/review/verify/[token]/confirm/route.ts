import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { isEnabled } from "@/lib/features/flags";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { verifyReviewToken } from "@/lib/db/queries/reviews";
import { notifyReviewVerified } from "@/lib/email/notify";
import { revalidateListingPaths } from "@/lib/revalidate/listing";
import { siteOrigin } from "@/lib/site-env";
import { REVIEW_VERIFY_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import type { TestDb } from "@/lib/db/types";

/**
 * POST /review/verify/<token>/confirm — the button on the landing page.
 *
 * POST only, deliberately. This is the request that puts a rating on a
 * business's public page, and the one thing standing between a mail-security
 * scanner (or a gateway link rewriter, or a chat link previewer, or the
 * browser's prefetcher) and a published review is that all of them issue GETs.
 * There is no GET export here: anything that follows this URL without
 * submitting the form gets a 405.
 *
 * Still safe to replay — the token is single-use and a second submit reports
 * the same outcome — but replay-safety was never the gap. Being reached
 * without a person was.
 */

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const origin = siteOrigin();
  // Build-time constant: with reviews off this route is a 404 like every other
  // part of the module.
  if (!isEnabled("reviews")) return new NextResponse(null, { status: 404 });

  // One bucket with the landing page: a guess loop against either is the
  // same loop, and a real reviewer spends two of the thirty.
  const limit = await limitPublicWrite("review-verify", request.headers, REVIEW_VERIFY_RATE_LIMIT);
  if (!limit.allowed) {
    return new NextResponse("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "no-store" },
    });
  }

  const { token } = await params;

  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const verified = await verifyReviewToken(handle, PUBLIC_VIEWER, decodeURIComponent(token));
    // Enqueued in the same transaction as the status change, so the owner is
    // never told about a review that rolled back.
    await notifyReviewVerified(handle, PUBLIC_VIEWER, verified);
    return verified;
  });

  // Both dead ends go back to the page the button was on, which knows how to
  // say what happened — and, for an expired link, how to offer a new one. A
  // 303 so the browser follows with a GET and the back button cannot resubmit.
  if (result.outcome === "unknown-token" || result.outcome === "expired") {
    return NextResponse.redirect(`${origin}/review/verify/${encodeURIComponent(token)}`, 303);
  }

  if (result.status === "published") {
    // The reviews page is ISR-cached, so without this the reviewer follows the
    // link and does not see their own review for up to an hour — and writes it
    // again. The listing page carries the average and the city pages print
    // the rating, so `paths` is the full `listingPaths` list, read by the
    // query inside the transaction; empty for a repeat click, which changed
    // nothing.
    revalidateListingPaths(result.paths);
    return NextResponse.redirect(`${origin}${result.path}/reviews`, 303);
  }

  // Held for a moderator. The listing id is in the URL so the page can be
  // reached directly, and it says plainly that a person is reading it.
  return NextResponse.redirect(`${origin}/leave-review/${result.listingId}/thanks`, 303);
}
