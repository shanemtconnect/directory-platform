"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { markEnquiryHandled, updateOwnerListing } from "@/lib/db/queries/owner";
import { validateOwnerListing } from "@/lib/account/form";
import type { Db } from "@/lib/db/client";

/**
 * The owner portal's two mutations.
 *
 * Neither takes an owner id. The scoping is inside the query, which resolves
 * the viewer's own profile — so a tampered listing id in a form post matches
 * nothing rather than matching somebody else's row.
 */

export interface OwnerFormState {
  status: "idle" | "saved" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

export async function saveOwnerListing(
  _prev: OwnerFormState,
  form: FormData,
): Promise<OwnerFormState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { status: "error", message: "Please sign in." };

  const listingId = String(form.get("listingId") ?? "");
  const { values, errors } = validateOwnerListing(form);
  if (errors) return { status: "error", fieldErrors: errors };

  const result = await db.transaction(async (tx) =>
    updateOwnerListing(tx as unknown as Db, viewer, listingId, values),
  );

  if (result.outcome === "not-found") {
    // Same answer as the page gives, and for the same reason: confirming the
    // listing exists tells somebody probing ids that it does.
    return { status: "error", message: "That listing could not be found." };
  }

  // The public page is ISR-cached and has just changed.
  revalidatePath(result.path);
  revalidatePath(`/account/listings/${listingId}`);
  return { status: "saved" };
}

export async function markEnquiry(
  enquiryId: string,
  action: "read" | "replied",
): Promise<{ ok: boolean }> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { ok: false };

  const ok = await db.transaction(async (tx) =>
    markEnquiryHandled(tx as unknown as Db, viewer, enquiryId, action),
  );
  return { ok };
}
