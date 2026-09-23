"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { isEnabled } from "@/lib/features/flags";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import {
  SHORTLIST_RATE_LIMIT,
  limitPublicWrite,
  retryMessage,
} from "@/lib/spam/write-limit";
import {
  MAX_SHORTLIST_ITEMS,
  SHORTLIST_COOKIE,
  addListingToShortlist,
  findShortlistByCookie,
  getOrCreateShortlistForCookie,
  newCookieId,
  removeListingFromShortlist,
  renameShortlistForCookie,
  setShortlistPublicForCookie,
} from "@/lib/db/queries/shortlist";

/**
 * Shortlist mutations for a visitor who is not signed in — because nobody is,
 * yet. Identity is an httpOnly cookie holding a random id, minted on the first
 * save. httpOnly matters: script on the page must not be able to read or forge
 * the value, because the value is the only thing that says this list is yours.
 */

export interface ShortlistState {
  ok: boolean;
  /** Shown to the visitor. Empty on a plain success. */
  message?: string;
  /** Present after a share toggle so the UI can render the link immediately. */
  shareId?: string;
  isPublic?: boolean;
}

const OK: ShortlistState = { ok: true };
const OFF: ShortlistState = { ok: false, message: "That isn't available on this site." };
const BROKEN: ShortlistState = { ok: false, message: "Something went wrong. Please try again." };

const YEAR_SECONDS = 60 * 60 * 24 * 365;

async function readCookieId(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(SHORTLIST_COOKIE)?.value ?? "";
  // Only ever accept a value we could have minted. A hand-crafted cookie is
  // still just an id, but there is no reason to let it be arbitrary text.
  return /^[A-Za-z0-9_-]{20,64}$/.test(value) ? value : null;
}

/**
 * Mints the cookie on first use. Secure only outside development, because a
 * Secure cookie is silently dropped over plain http and the whole feature
 * would look broken on localhost.
 */
async function mintCookieId(): Promise<string> {
  const id = newCookieId();
  const jar = await cookies();
  jar.set(SHORTLIST_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: YEAR_SECONDS,
  });
  return id;
}

/**
 * Every shortlist mutation passes through here, sharing one bucket per client.
 *
 * All four are public writes: add and remove create and delete rows, rename
 * stores text the visitor typed, and setPublic decides whether a list is
 * readable by anyone holding its link. Only `addToShortlist` used to count
 * anything, which meant the write that stores attacker-controlled text was the
 * unmetered one. Returns null when the request is within its budget.
 */
async function overLimit(): Promise<ShortlistState | null> {
  const limit = await limitPublicWrite("shortlist", await headers(), SHORTLIST_RATE_LIMIT);
  return limit.allowed ? null : { ok: false, message: retryMessage(limit) };
}

/**
 * Saves a listing, creating the visitor's list and cookie if this is their
 * first save.
 *
 * The per-list cap lives in SQL; this limit is the other half of the same
 * problem — one client minting endless cookies to create endless lists.
 */
export async function addToShortlist(listingId: string): Promise<ShortlistState> {
  if (!isEnabled("shortlist")) return OFF;
  if (typeof listingId !== "string" || listingId.length === 0) return BROKEN;

  const blocked = await overLimit();
  if (blocked) return blocked;

  try {
    const cookieId = (await readCookieId()) ?? (await mintCookieId());
    const list = await getOrCreateShortlistForCookie(db as never, PUBLIC_VIEWER, cookieId);
    const result = await addListingToShortlist(
      db as never,
      PUBLIC_VIEWER,
      list.id,
      listingId,
    );

    if (result.ok) {
      revalidatePath("/shortlist");
      return OK;
    }
    switch (result.reason) {
      case "full":
        return {
          ok: false,
          message: `Your list is full at ${MAX_SHORTLIST_ITEMS}. Remove one to add another.`,
        };
      case "duplicate":
        // Already saved is the outcome the visitor wanted. Don't call it an error.
        return OK;
      case "not-found":
        return { ok: false, message: "That is no longer available." };
    }
  } catch {
    return BROKEN;
  }
}

export async function removeFromShortlist(listingId: string): Promise<ShortlistState> {
  if (!isEnabled("shortlist")) return OFF;
  if (typeof listingId !== "string" || listingId.length === 0) return BROKEN;

  const blocked = await overLimit();
  if (blocked) return blocked;

  try {
    const cookieId = await readCookieId();
    // No cookie means no list, which means it is already not on it.
    if (!cookieId) return OK;
    const list = await findShortlistByCookie(db as never, PUBLIC_VIEWER, cookieId);
    if (!list) return OK;

    await removeListingFromShortlist(db as never, PUBLIC_VIEWER, list.id, listingId);
    revalidatePath("/shortlist");
    return OK;
  } catch {
    return BROKEN;
  }
}

export async function renameShortlist(name: string): Promise<ShortlistState> {
  if (!isEnabled("shortlist")) return OFF;
  if (typeof name !== "string") return BROKEN;

  const blocked = await overLimit();
  if (blocked) return blocked;

  try {
    const cookieId = await readCookieId();
    if (!cookieId) return { ok: false, message: "Save something first." };

    const row = await renameShortlistForCookie(db as never, PUBLIC_VIEWER, cookieId, name);
    if (!row) return { ok: false, message: "Save something first." };
    revalidatePath("/shortlist");
    return OK;
  } catch {
    return BROKEN;
  }
}

/**
 * Turns the share link on or off.
 *
 * The shareId is minted once, when the list is created, and never rotates
 * here: a visitor who unshares and reshares keeps the same link. If link
 * revocation ever needs to be real, rotate the shareId on unshare — but that
 * silently breaks every copy of the old link, so it is a product decision, not
 * a detail to slip in.
 */
export async function setPublic(isPublic: boolean): Promise<ShortlistState> {
  if (!isEnabled("shortlist")) return OFF;
  if (typeof isPublic !== "boolean") return BROKEN;

  const blocked = await overLimit();
  if (blocked) return blocked;

  try {
    const cookieId = await readCookieId();
    if (!cookieId) return { ok: false, message: "Save something first." };

    const row = await setShortlistPublicForCookie(
      db as never,
      PUBLIC_VIEWER,
      cookieId,
      isPublic,
    );
    if (!row) return { ok: false, message: "Save something first." };

    revalidatePath("/shortlist");
    revalidatePath(`/shortlist/${row.shareId}`);
    return { ok: true, shareId: row.shareId, isPublic: row.isPublic };
  } catch {
    return BROKEN;
  }
}
