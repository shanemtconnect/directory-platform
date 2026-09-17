"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { updateOwnProfile } from "@/lib/db/queries/profile";
import { clientIp } from "@/lib/spam/client-ip";
import { stripCrlf } from "@/lib/actions/validation";
import type { TestDb } from "@/test/db";

/**
 * The one write behind /account/settings.
 *
 * It takes no id. The row is chosen by the session (lib/db/queries/profile.ts),
 * so "whose profile is this" is not a parameter and therefore not something an
 * action can be tricked about — which matters more here than anywhere, because
 * this is the first form on the site that edits a row belonging to the person
 * submitting it.
 *
 * The layout at app/account/layout.tsx already redirects a signed-out visitor,
 * but constraint 23 applies just as much to owner routes as to admin ones: a
 * layout is not a security boundary for a server action, which can be POSTed
 * to directly. The viewer is re-read here.
 */

export interface ProfileFormState {
  status: "idle" | "saved" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

const MAX = { name: 120, phone: 40 } as const;

export async function saveProfile(
  _prev: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") {
    return { status: "error", message: "Please sign in again." };
  }

  const name = stripCrlf(String(form.get("name") ?? "")).trim();
  const phone = stripCrlf(String(form.get("phone") ?? "")).trim();
  // A checkbox absent from the body is an unticked box, which is the whole
  // reason consent has to be read this way round: opt-in defaults to off.
  const marketingOptIn = form.get("marketingOptIn") === "on";

  const fieldErrors: Record<string, string> = {};
  if (name.length < 2) fieldErrors.name = "Please give your name.";
  if (name.length > MAX.name) fieldErrors.name = "That name is too long.";
  if (phone.length > MAX.phone) fieldErrors.phone = "That phone number is too long.";
  if (Object.keys(fieldErrors).length > 0) {
    return { status: "error", fieldErrors, message: "Please check the fields marked below." };
  }

  const ip = clientIp(await headers());

  await db.transaction(async (tx) => {
    // The same cast every other action uses: a transaction handle and the root
    // client expose one query surface to lib/db/queries.
    await updateOwnProfile(tx as unknown as TestDb, viewer, {
      name,
      phone: phone === "" ? null : phone,
      marketingOptIn,
      ip,
    });
  });

  // The banner and anything else reading the profile are server-rendered.
  revalidatePath("/account");

  return { status: "saved", message: "Saved." };
}
