"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/viewer";
import { clientIp } from "@/lib/spam/client-ip";
import {
  actionRemovalRequest,
  actionReport,
  type DecisionResult,
  type RemovalDecision,
  type ReportDecision,
} from "@/lib/db/queries/trust";
import { submissionDetail } from "@/lib/db/queries/admin/submissions";
import type { TestDb } from "@/lib/db/types";

/**
 * The four decisions behind /admin/reports and /admin/removals.
 *
 * Every one calls `requireAdmin()` first. `app/admin/layout.tsx` gates the
 * PAGES, and a server action is not a page — its endpoint is reachable by
 * anyone who can read the id out of the HTML, layout or no layout (global
 * constraint 23).
 *
 * Nothing here writes an audit row. `lib/db/queries/trust.ts` already writes
 * one per decision on the same handle as the change, which is what constraint
 * 22 asks for; a second row from this layer would describe the same click
 * twice. Nothing here touches Drizzle either (constraint 6) and nothing here
 * sends an email — the removal notification is enqueued inside the transaction
 * by `actionRemovalRequest`, so a rolled-back takedown cannot leave a "your
 * listing has been removed" message behind it.
 *
 * These return a state rather than redirecting. The queue is a list of rows
 * with two buttons each, and the interesting failure is somebody else deciding
 * the same row first: a redirect back to a queue the row has vanished from
 * looks identical to success. `useActionState` gives the row somewhere to say
 * what happened.
 */

/** The uuid a form field has to be before it is worth opening a transaction. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readId(form: FormData, field: string): string | null {
  const value = form.get(field);
  return typeof value === "string" && UUID.test(value) ? value : null;
}

export interface QueueState {
  status: "idle" | "done" | "error";
  message?: string;
}

const GONE = "That is not there any more. Reload the queue to see what is left.";

/**
 * What to tell an admin who clicked a row somebody else had already dealt
 * with. `forbidden` is unreachable behind `requireAdmin()` and is mapped
 * anyway: the day it stops being unreachable is not the day to find out that
 * the queue reported success.
 */
function message(result: DecisionResult): string | null {
  switch (result.outcome) {
    case "not-open":
      return "Somebody has already decided this one. Reload the queue to see what is left.";
    case "unknown":
      return GONE;
    case "forbidden":
      return "You are not allowed to decide this.";
    default:
      return null;
  }
}

function settle(result: DecisionResult): QueueState {
  const failure = message(result);
  return failure === null ? { status: "done" } : { status: "error", message: failure };
}

/* ----------------------------------------------------------------- reports */

/**
 * A report decision changes nothing a visitor can see — it closes a row in a
 * queue — so only the console's own pages are revalidated. The dashboard is in
 * the list because it counts what is open, and a tile that still says 3 after
 * the queue is empty is how an admin stops trusting the tiles.
 */
async function decideReport(form: FormData, decision: ReportDecision): Promise<QueueState> {
  const viewer = await requireAdmin();
  const reportId = readId(form, "reportId");
  if (reportId === null) return { status: "error", message: GONE };

  const ip = clientIp(await headers());

  const result = await db.transaction(
    async (tx) => await actionReport(tx as unknown as TestDb, viewer, reportId, decision, { ip }),
  );

  const state = settle(result);
  if (state.status === "done") {
    revalidatePath("/admin/reports");
    revalidatePath("/admin");
  }
  return state;
}

/** Nothing was wrong with the listing, or nothing we are going to act on. */
export async function dismissReportAction(
  _prev: QueueState,
  form: FormData,
): Promise<QueueState> {
  return await decideReport(form, "dismissed");
}

/** The correction has been made. The edit itself happens on the listing. */
export async function markReportActionedAction(
  _prev: QueueState,
  form: FormData,
): Promise<QueueState> {
  return await decideReport(form, "actioned");
}

/* ------------------------------------------------------------- removals */

/**
 * The takedown, and its refusal.
 *
 * `actionRemovalRequest` does the three things a removal means — the listing
 * goes to `removed`, a suppression row stops the next import putting it back,
 * and the requester is emailed — inside the one transaction this opens.
 *
 * The paths to revalidate are read from `submissionDetail` BEFORE the decision
 * and on the same handle, because afterwards the listing is `removed` and the
 * city page it needs to disappear from is still cached under a URL nothing left
 * in the queue knows. `listingId` comes from the queue row we rendered; it is
 * used for nothing but working out which cached pages are now wrong, and a
 * missing or malformed one costs a cache bust, not a decision.
 */
async function decideRemoval(form: FormData, decision: RemovalDecision): Promise<QueueState> {
  const viewer = await requireAdmin();
  const removalRequestId = readId(form, "removalRequestId");
  if (removalRequestId === null) return { status: "error", message: GONE };

  const listingId = readId(form, "listingId");
  const ip = clientIp(await headers());

  const outcome = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const detail = listingId === null ? null : await submissionDetail(handle, viewer, listingId);
    const result = await actionRemovalRequest(handle, viewer, removalRequestId, decision, { ip });
    return { detail, result };
  });

  const state = settle(outcome.result);
  if (state.status !== "done") return state;

  revalidatePath("/admin/removals");
  revalidatePath("/admin");

  // Only a takedown changes the public site. A rejection leaves the listing
  // exactly where it was, so there is nothing cached that is now wrong.
  if (decision === "actioned" && outcome.detail !== null) {
    const { citySlug, slug, categorySlug } = outcome.detail;
    revalidatePath(`/${citySlug}/${slug}`);
    // Its reviews sub-page is a separate ISR route that must come down too.
    revalidatePath(`/${citySlug}/${slug}/reviews`);
    revalidatePath(`/${citySlug}`);
    if (categorySlug !== null) revalidatePath(`/${citySlug}/${categorySlug}`);
  }
  return state;
}

export async function actionRemovalAction(
  _prev: QueueState,
  form: FormData,
): Promise<QueueState> {
  return await decideRemoval(form, "actioned");
}

export async function rejectRemovalAction(
  _prev: QueueState,
  form: FormData,
): Promise<QueueState> {
  return await decideRemoval(form, "rejected");
}
