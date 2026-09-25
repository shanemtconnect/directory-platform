"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer, requireAdmin } from "@/lib/auth/viewer";
import { features } from "@/lib/features/flags";
import { clientIp } from "@/lib/spam/client-ip";
import { isUuid } from "@/lib/actions/validation";
import { CREDIT_PATH, startTopup } from "@/lib/billing/credit-topup";
import { adminAdjust, profileIdByEmail } from "@/lib/db/queries/credits";
import type { TestDb } from "@/lib/db/types";

/**
 * Lead-credit writes (Task 57). Both 404 with the flag off: a server action
 * is an endpoint, and `guardFeature` on the page is not a boundary for it.
 *
 * A top-up creates its PayPal order INSIDE the transaction that creates the
 * `credit_orders` row, so a failed create leaves nothing behind, and the
 * buyer is sent to PayPal only once both have committed — the jobs board's
 * rule (lib/actions/jobs.ts).
 */

function assertFlag(): void {
  if (!features.leadMarketplace) throw new Error("NOT_FOUND");
}

export async function startTopupAction(form: FormData): Promise<void> {
  assertFlag();
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect(`/login?next=${CREDIT_PATH}`);

  const packCents = Number(form.get("packCents"));
  const result = await db.transaction(async (tx) => startTopup(tx as unknown as TestDb, viewer, packCents));
  if (result.outcome === "pay") redirect(result.approveUrl);
  redirect(`${CREDIT_PATH}?topup=${result.outcome}`);
}

const ADMIN_CREDIT = "/admin/credit";

/**
 * `amount` is in major units and signed: "-10" takes ten off. The account is
 * named by `userId` (a row's form) or by `email` (the form for an account
 * that has never held credit).
 */
export async function adminAdjustAction(form: FormData): Promise<void> {
  assertFlag();
  const viewer = await requireAdmin();
  const email = String(form.get("email") ?? "").trim();
  const userId =
    email !== ""
      ? ((await profileIdByEmail(db as unknown as TestDb, viewer, email)) ?? "")
      : String(form.get("userId") ?? "");
  const amount = Number(String(form.get("amount") ?? "").trim());
  const note = String(form.get("note") ?? "");
  if (!isUuid(userId)) redirect(`${ADMIN_CREDIT}?adjust=unknown-account`);
  if (!Number.isFinite(amount)) redirect(`${ADMIN_CREDIT}?adjust=invalid-amount`);

  const cents = Math.round(amount * 100);
  const ip = clientIp(await headers());
  const result = await db.transaction(async (tx) =>
    adminAdjust(tx as unknown as TestDb, viewer, { userId, cents, note, ip }),
  );
  redirect(`${ADMIN_CREDIT}?adjust=${result.outcome}`);
}
