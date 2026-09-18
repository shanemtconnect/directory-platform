"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/viewer";
import { clientIp } from "@/lib/spam/client-ip";
import { moderateReview, type ModerateReviewResult } from "@/lib/db/queries/reviews";
import { listingPaths } from "@/lib/db/queries/paths";
import { revalidateListingPaths } from "@/lib/revalidate/listing";
import type { QueueState } from "@/lib/actions/admin-trust";
import type { TestDb } from "@/lib/db/types";

/**
 * The two decisions behind /admin/reviews.
 *
 * Both call `requireAdmin()` first. `app/admin/layout.tsx` gates the PAGE, and
 * a server action is not a page — its endpoint is reachable by anyone who can
 * read the id out of the HTML (global constraint 23).
 *
 * Nothing here writes an audit row or touches the aggregate: `moderateReview`
 * writes the audit row (with the moderator's IP, constraint 22) and recomputes
 * `listings.rating_avg` / `rating_count` on the same handle as the status
 * change, so a rolled-back decision leaves neither behind. Nothing here
 * touches Drizzle (constraint 6).
 *
 * The listing's paths are read on the same handle, after the decision, from
 * the listing id the decision returns — the form carries only the review id,
 * so the set of pages this busts is never something the browser chose.
 *
 * These return a state rather than redirecting, for the same reason as the
 * report queue: two admins can be looking at the queue at once, and the
 * interesting failure is the second one clicking a row the first has decided.
 */

/** The uuid a form field has to be before it is worth opening a transaction. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readId(form: FormData, field: string): string | null {
  const value = form.get(field);
  return typeof value === "string" && UUID.test(value) ? value : null;
}

const GONE = "That review is not there any more. Reload the queue to see what is left.";

function settle(result: ModerateReviewResult): QueueState {
  return result.outcome === "updated" ? { status: "done" } : { status: "error", message: GONE };
}

async function decide(form: FormData, status: "published" | "rejected"): Promise<QueueState> {
  const viewer = await requireAdmin();
  const reviewId = readId(form, "reviewId");
  if (reviewId === null) return { status: "error", message: GONE };

  const ip = clientIp(await headers());

  const outcome = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const result = await moderateReview(handle, viewer, reviewId, { status, ip });
    // After the decision is fine here: moderating a review never changes the
    // city's published count, so the page list is the same either side.
    const paths =
      result.outcome === "updated" ? await listingPaths(handle, viewer, result.listingId) : [];
    return { result, paths };
  });

  const state = settle(outcome.result);
  if (state.status !== "done") return state;

  revalidatePath("/admin/reviews");
  revalidatePath("/admin");

  // The rating is printed on the listing page, listed in full on its reviews
  // page, and shown on every card on the town, paginated and pillar pages.
  // Publishing and rejecting both move it — a rejection can pull a review
  // that was published in the meantime — so both bust the same set.
  revalidateListingPaths(outcome.paths);
  return state;
}

/** The held review goes on the page and into the aggregate. */
export async function publishReviewAction(
  _prev: QueueState,
  form: FormData,
): Promise<QueueState> {
  return await decide(form, "published");
}

/** The held review stays off the page. Its reason stays on the row. */
export async function rejectReviewAction(
  _prev: QueueState,
  form: FormData,
): Promise<QueueState> {
  return await decide(form, "rejected");
}
