import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { isEnabled } from "@/lib/features/flags";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { verifyReviewToken } from "@/lib/db/queries/reviews";
import { notifyReviewVerified } from "@/lib/email/notify";
import { siteOrigin } from "@/lib/site-env";
import type { TestDb } from "@/test/db";

/**
 * The link in the verification email. Clicking it is what publishes a review.
 *
 * A GET that writes, which is normally the wrong shape — but the thing being
 * clicked is a link in an email, and every alternative (a form, a POST, a
 * confirm button) costs conversions on the one action the whole module depends
 * on. It is safe to replay: the token is single-use, a second click reports the
 * same outcome, and nothing is created.
 *
 * A route handler rather than a page because its whole job is to decide where
 * the reader goes next. Whatever happens, they land on a real page — the
 * reviews page with their review on it, or the honest "a person is reading it"
 * page — rather than on a URL with a token in it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const origin = siteOrigin();
  // Build-time constant: with reviews off this route is a 404 like every other
  // part of the module.
  if (!isEnabled("reviews")) return new NextResponse(null, { status: 404 });

  const { token } = await params;

  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const verified = await verifyReviewToken(handle, PUBLIC_VIEWER, decodeURIComponent(token));
    // Enqueued in the same transaction as the status change, so the owner is
    // never told about a review that rolled back.
    await notifyReviewVerified(handle, PUBLIC_VIEWER, verified);
    return verified;
  });

  if (result.outcome === "unknown-token") {
    // A token nobody issued, or one that never matched a review. Not a
    // redirect: there is nowhere meaningful to send them.
    return new NextResponse(null, { status: 404 });
  }

  if (result.status === "published") {
    // The reviews page is ISR-cached, so without this the reviewer follows the
    // link and does not see their own review for up to an hour — and writes it
    // again. The listing page carries the average, so it goes too.
    revalidatePath(`${result.path}/reviews`);
    revalidatePath(result.path);
    return NextResponse.redirect(`${origin}${result.path}/reviews`, 303);
  }

  // Held for a moderator. The listing id is in the URL so the page can be
  // reached directly, and it says plainly that a person is reading it.
  return NextResponse.redirect(`${origin}/leave-review/${result.listingId}/thanks`, 303);
}
