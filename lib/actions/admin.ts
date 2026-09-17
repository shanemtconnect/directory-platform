"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/viewer";
import { clientIp } from "@/lib/spam/client-ip";
import {
  approveSubmission,
  rejectSubmission,
  submissionDetail,
  type DecisionResult,
} from "@/lib/db/queries/admin/submissions";
import { saveCityIntro, setCityPublished } from "@/lib/db/queries/admin/cities";
import type { TestDb } from "@/lib/db/types";

/**
 * The admin console's four writes.
 *
 * Every one of them calls `requireAdmin()` first. `app/admin/layout.tsx` gates
 * the PAGES, and a server action is not a page: its endpoint is reachable by
 * anyone who can read the id out of the HTML, layout or no layout (global
 * constraint 23).
 *
 * Each action opens ONE transaction and hands the handle to a query function
 * that does the status change, the gate recompute, the audit row and the job
 * enqueue together. Nothing here touches Drizzle (constraint 6) and nothing
 * here sends an email — a decision either commits whole or not at all.
 */

/** The uuid a form field has to be before it is worth opening a transaction. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readId(form: FormData, field: string): string | null {
  const value = form.get(field);
  return typeof value === "string" && UUID.test(value) ? value : null;
}

/**
 * A decision changes what the public sees, and the pillar pages are ISR-cached.
 * Without this the listing is live in the database and absent from its city
 * page — and its category's pillar page within that city — until the
 * revalidate window happens to expire.
 */
function revalidateListing(citySlug: string, slug: string, categorySlug: string | null): void {
  revalidatePath(`/${citySlug}`);
  revalidatePath(`/${citySlug}/${slug}`);
  // The reviews sub-page is its own ISR route and 404s for an unpublished
  // listing, so it goes stale (or comes back) with the listing itself.
  revalidatePath(`/${citySlug}/${slug}/reviews`);
  if (categorySlug !== null) revalidatePath(`/${citySlug}/${categorySlug}`);
  revalidatePath("/admin/submissions");
}

export async function approveSubmissionAction(form: FormData): Promise<void> {
  const viewer = await requireAdmin();
  const listingId = readId(form, "listingId");
  if (listingId === null) redirect("/admin/submissions");

  const ip = clientIp(await headers());

  const outcome = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const detail = await submissionDetail(handle, viewer, listingId);
    const result = await approveSubmission(handle, viewer, listingId, { ip });
    return { result, detail };
  });

  if (outcome.result.outcome !== "approved") {
    // Somebody else decided it, or the id is gone. The detail page shows the
    // status it is actually in, which is the answer to both.
    redirect(`/admin/submissions/${listingId}`);
  }
  if (outcome.detail) {
    revalidateListing(outcome.detail.citySlug, outcome.detail.slug, outcome.detail.categorySlug);
  }
  redirect("/admin/submissions");
}

export interface RejectState {
  status: "idle" | "error";
  message?: string;
}

/**
 * The one client-rendered form in the console, because a rejection needs a
 * reason and a reason needs somewhere to say "you have not given one".
 */
export async function rejectSubmissionAction(
  _prev: RejectState,
  form: FormData,
): Promise<RejectState> {
  const viewer = await requireAdmin();
  const listingId = readId(form, "listingId");
  if (listingId === null) return { status: "error", message: "That submission is not there." };

  const reason = String(form.get("reason") ?? "");
  const ip = clientIp(await headers());

  const outcome = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const detail = await submissionDetail(handle, viewer, listingId);
    const result = await rejectSubmission(handle, viewer, listingId, reason, { ip });
    return { result, detail };
  });

  const failure = rejectionMessage(outcome.result);
  if (failure) return { status: "error", message: failure };

  if (outcome.detail) {
    revalidateListing(outcome.detail.citySlug, outcome.detail.slug, outcome.detail.categorySlug);
  }
  redirect("/admin/submissions");
}

function rejectionMessage(result: DecisionResult): string | null {
  switch (result.outcome) {
    case "reason-required":
      return "Please say why, so the submitter is told something useful.";
    case "unknown-listing":
      return "That submission is not there.";
    case "not-pending":
      return `Nothing to do: this is already ${result.status}.`;
    default:
      return null;
  }
}

export async function saveCityIntroAction(form: FormData): Promise<void> {
  const viewer = await requireAdmin();
  const cityId = readId(form, "cityId");
  if (cityId === null) redirect("/admin/cities");

  const intro = String(form.get("intro") ?? "");
  const slug = String(form.get("citySlug") ?? "");
  const ip = clientIp(await headers());

  await db.transaction(async (tx) => {
    await saveCityIntro(tx as unknown as TestDb, viewer, cityId, intro, { ip });
  });

  // The intro copy IS the city page's opening paragraph and half of its
  // indexing gate, so the cached page is wrong the moment this commits.
  if (slug !== "") revalidatePath(`/${slug}`);
  revalidatePath("/admin/cities");
  redirect("/admin/cities");
}

export async function setCityPublishedAction(form: FormData): Promise<void> {
  const viewer = await requireAdmin();
  const cityId = readId(form, "cityId");
  if (cityId === null) redirect("/admin/cities");

  const isPublished = form.get("isPublished") === "true";
  const slug = String(form.get("citySlug") ?? "");
  const ip = clientIp(await headers());

  await db.transaction(async (tx) => {
    await setCityPublished(tx as unknown as TestDb, viewer, cityId, isPublished, { ip });
  });

  if (slug !== "") revalidatePath(`/${slug}`);
  revalidatePath("/admin/cities");
  redirect("/admin/cities");
}
