import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { verifyClaimToken } from "@/lib/db/queries/claims";
import type { Db } from "@/lib/db/client";

/**
 * GET /claim/verify/<token> — the magic link coming back.
 *
 * A GET that mutates, which is the one place that is right: the link is opened
 * from an email client, and an email client cannot POST. The token is a single
 * 256-bit secret that was sent to an address on the business's own domain, and
 * the listing goes to the profile that STARTED the claim rather than to
 * whoever clicked — so a forwarded link cannot redirect ownership.
 *
 * Everything ends at /account. The link is usually opened in a different
 * browser from the one that started the claim, so the sign-in that /account
 * demands is the confirmation that the right person arrived; the claim itself
 * is already applied by then.
 */

export const dynamic = "force-dynamic";

function back(request: Request, outcome: string): Response {
  const url = new URL(`/account?claim=${outcome}`, request.url);
  return Response.redirect(url, 303);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const viewer = await currentViewer();

  const result = await db.transaction(async (tx) =>
    verifyClaimToken(tx as unknown as Db, viewer, decodeURIComponent(token)),
  );

  if (result.outcome !== "approved") return back(request, result.outcome);

  // The listing page is ISR-cached and now says something different about who
  // owns it. Without this the change is invisible until the cache turns over.
  revalidatePath(result.path);
  return back(request, "approved");
}
