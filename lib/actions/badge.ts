"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { registerBacklink, BACKLINK_URL_MAX_LENGTH } from "@/lib/db/queries/badges";
import { clientIp } from "@/lib/spam/client-ip";
import { BADGE_BACKLINK_RATE_LIMIT, limitPublicWrite, retryMessage } from "@/lib/spam/write-limit";
import { isUuid, stripCrlf } from "@/lib/actions/validation";
import type { TestDb } from "@/lib/db/types";

/**
 * "Where did you put the badge?" — the one write behind /advertise/badge/mine.
 *
 * The ownership check is inside `registerBacklink` (constraint 24), so this
 * takes no owner id and trusts nothing in the form beyond its shape. Order:
 * session, then the two checks that cost nothing (a uuid-shaped id and a
 * non-empty field), then the hourly budget, then one transaction that
 * resolves the viewer's profile (constraint 21) and registers with the
 * request address for the audit row (constraint 22).
 *
 * "Check now" on the page posts the same URL to this same action: the query
 * treats a re-registration of the same URL as "make it due again".
 */

export interface BacklinkFormState {
  status: "idle" | "saved" | "error";
  message?: string;
  /** What was stored, normalised, so the form can show it back. */
  url?: string;
}

export async function registerBacklinkAction(
  _prev: BacklinkFormState,
  form: FormData,
): Promise<BacklinkFormState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") {
    return { status: "error", message: "Sign in to the account that owns this listing first." };
  }

  const listingId = String(form.get("listingId") ?? "");
  if (!isUuid(listingId)) return { status: "error", message: "That listing could not be found." };

  const url = stripCrlf(String(form.get("url") ?? "")).trim();
  if (url === "") {
    return { status: "error", message: "Enter the URL of the page the badge is on." };
  }

  const requestHeaders = await headers();
  const limit = await limitPublicWrite("badge-backlink", requestHeaders, BADGE_BACKLINK_RATE_LIMIT);
  if (!limit.allowed) return { status: "error", message: retryMessage(limit) };

  const ip = clientIp(requestHeaders);
  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const profile = await ensureProfile(handle, viewer);
    return registerBacklink(handle, viewer, {
      listingId,
      url,
      actorProfileId: profile.id,
      ip,
    });
  });

  switch (result.outcome) {
    case "registered":
      revalidatePath("/advertise/badge/mine");
      return { status: "saved", url: result.url };
    case "not-owner":
      return { status: "error", message: "Only the owner of this listing can say where its badge is." };
    case "too-long":
      return {
        status: "error",
        message: `That URL is too long — ${BACKLINK_URL_MAX_LENGTH} characters is the most we store.`,
      };
    case "invalid-url":
      return {
        status: "error",
        message: "That does not look like a full address. It needs to start with https:// or http://.",
      };
    case "wrong-scheme":
      return { status: "error", message: "The page has to be a web page: https:// or http://." };
    case "no-website":
      return {
        status: "error",
        message:
          "Your listing has no website for us to match the page against. Add your website to the listing first, then come back.",
      };
    case "domain-mismatch":
      return {
        status: "error",
        message: `The page has to be on your own site, ${result.expected} — a badge on somebody else's site is not yours to register.`,
      };
  }
}
