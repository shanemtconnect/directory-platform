"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/viewer";
import { clientIp } from "@/lib/spam/client-ip";
import { features } from "@/lib/features/flags";
import {
  awardsCityPath,
  computeAwardsForYear,
  parseAwardYear,
  revokeAward,
  type ComputeAwardsResult,
  type RevokeAwardResult,
} from "@/lib/db/queries/awards";
import { listingPaths } from "@/lib/db/queries/paths";
import { revalidateListingPaths } from "@/lib/revalidate/listing";
import type { TestDb } from "@/lib/db/types";

/**
 * The two things an admin can do to awards (Task 50): compute a year, and
 * take one back.
 *
 * Both call `requireAdmin()` first — the layout gates the page, not the
 * endpoint (global constraint 23) — and both refuse outright when the module
 * is off, because a server action is reachable whether or not any page links
 * it. Nothing here touches Drizzle: the query functions write the rows, the
 * queued emails and the audit rows on one handle, and hand back what to bust.
 */

export interface AwardsActionState {
  status: "idle" | "done" | "error";
  message?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A revoke reason has to say something, and does not need to be an essay. */
// Not exported: a "use server" module may export async functions only.
const MAX_REVOKE_REASON_CHARS = 500;

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function bustAwardPages(year: number, citySlugs: Iterable<string>): void {
  revalidatePath("/admin/awards");
  revalidatePath(`/admin/awards/${year}`);
  revalidatePath("/awards");
  revalidatePath(`/awards/${year}`);
  for (const slug of new Set(citySlugs)) revalidatePath(awardsCityPath(year, slug));
}

function describe(result: ComputeAwardsResult): string {
  const { created, skipped } = result;
  if (created.length === 0 && skipped === 0) {
    return `No town and category had enough rated listings for ${result.year}. Nothing was awarded.`;
  }
  if (created.length === 0) {
    return `${result.year} was already decided: ${skipped} ${skipped === 1 ? "award" : "awards"} in place, nothing new.`;
  }
  return `${created.length} ${created.length === 1 ? "award" : "awards"} decided for ${result.year}` +
    (skipped > 0 ? `, ${skipped} already in place.` : ".") +
    " Each winner is being emailed.";
}

/** "Compute <year>". Idempotent: a second press reports what is already there. */
export async function computeAwardsAction(
  _prev: AwardsActionState,
  form: FormData,
): Promise<AwardsActionState> {
  const viewer = await requireAdmin();
  if (!features.awards) return { status: "error", message: "The awards module is off on this site." };

  const year = parseAwardYear(field(form, "year"));
  if (year === null) return { status: "error", message: "Enter a four-digit year." };

  const ip = clientIp(await headers());

  const outcome = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const result = await computeAwardsForYear(handle, viewer, year, { ip });
    const paths: string[] = [];
    for (const c of result.created) paths.push(...(await listingPaths(handle, viewer, c.listingId)));
    return { result, paths };
  });

  if (outcome.result.created.length > 0) {
    bustAwardPages(year, outcome.result.created.map((c) => c.citySlug));
    revalidateListingPaths(outcome.paths);
  } else {
    revalidatePath("/admin/awards");
  }
  return { status: "done", message: describe(outcome.result) };
}

const GONE = "That award is not there any more. Reload the page to see what is left.";

function settleRevoke(result: RevokeAwardResult): AwardsActionState {
  if (result.outcome === "revoked") return { status: "done", message: "Revoked. It is off the listing and the winners page." };
  if (result.outcome === "already-revoked") return { status: "error", message: "That award was already revoked." };
  return { status: "error", message: GONE };
}

/** Takes an award back, with a reason that goes to the audit log with the admin's IP. */
export async function revokeAwardAction(
  _prev: AwardsActionState,
  form: FormData,
): Promise<AwardsActionState> {
  const viewer = await requireAdmin();
  if (!features.awards) return { status: "error", message: "The awards module is off on this site." };

  const awardId = field(form, "awardId");
  if (!UUID.test(awardId)) return { status: "error", message: GONE };
  const reason = field(form, "reason");
  if (reason === "") return { status: "error", message: "Say why. The reason is recorded in the audit log." };
  if (reason.length > MAX_REVOKE_REASON_CHARS) {
    return { status: "error", message: `Keep the reason under ${MAX_REVOKE_REASON_CHARS} characters.` };
  }

  const ip = clientIp(await headers());

  const outcome = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const result = await revokeAward(handle, viewer, awardId, { reason, ip });
    const paths = result.outcome === "revoked" ? await listingPaths(handle, viewer, result.listingId) : [];
    return { result, paths };
  });

  const state = settleRevoke(outcome.result);
  if (outcome.result.outcome === "revoked") {
    bustAwardPages(outcome.result.year, [outcome.result.citySlug]);
    revalidateListingPaths(outcome.paths);
  }
  return state;
}
