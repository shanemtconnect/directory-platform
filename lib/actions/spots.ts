"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { clientIp } from "@/lib/spam/client-ip";
import { limitPublicWrite } from "@/lib/spam/write-limit";
import { getPayPalClient } from "@/lib/billing/paypal";
import { formatMoney } from "@/lib/pricing";
import { cancelOwnBid, placeBid } from "@/lib/spots/bidding";
import { bidRejectionMessage, UNIT_CENTS } from "@/lib/spots/rank";
import { revalidateListingPaths } from "@/lib/revalidate/listing";
import { isUuid } from "@/lib/actions/validation";
import type { SpotKey } from "@/lib/db/queries/spots";
import type { TestDb } from "@/lib/db/types";

/**
 * The owner's two moves on a featured spot: bid (which covers a first bid, a
 * raise and a lowering) and cancel. Ownership, eligibility and the spot's
 * rules are all re-derived inside `lib/spots/bidding.ts`; the hidden fields
 * on the form are a suggestion, not a boundary.
 */

/** Thirty an hour: every bid may be a PayPal call. */
const BID_RATE_LIMIT = { limit: 30, windowSeconds: 3600 } as const;

const NOT_SET_UP = "Featured spots are not set up on this site yet.";
const GENERIC = "Something went wrong with that bid. Please try again.";

export interface BidState {
  status: "idle" | "error" | "applied";
  message?: string;
  /** The spot the message is about, so a table of forms shows it in the right row. */
  keyString?: string;
}

const money = (cents: number) => formatMoney(cents / UNIT_CENTS, siteConfig.locale, siteConfig.currency);

function parseSpotKey(form: FormData): SpotKey | null {
  const areaKind = String(form.get("areaKind") ?? "");
  const areaId = String(form.get("areaId") ?? "").trim();
  const categoryId = String(form.get("categoryId") ?? "").trim();
  if (areaKind !== "city" && areaKind !== "region") return null;
  if (areaId === "" || areaId.length > 200) return null;
  if (categoryId !== "" && !isUuid(categoryId)) return null;
  return { areaKind, areaId, categoryId: categoryId === "" ? null : categoryId };
}

export async function placeBidAction(_prev: BidState, form: FormData): Promise<BidState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { status: "error", message: "Please sign in to bid." };

  const listingId = String(form.get("listingId") ?? "").trim();
  const spot = parseSpotKey(form);
  const amountRaw = String(form.get("amount") ?? "").trim();
  const amountUnits = /^\d{1,6}$/.test(amountRaw) ? Number(amountRaw) : Number.NaN;
  if (!isUuid(listingId) || spot === null) return { status: "error", message: GENERIC };
  const keyString = `${spot.areaKind}:${spot.areaId}:${spot.categoryId ?? "-"}`;
  if (!Number.isInteger(amountUnits) || amountUnits <= 0) {
    return { status: "error", keyString, message: "Enter a whole monthly amount." };
  }

  const requestHeaders = await headers();
  const limit = await limitPublicWrite("spots-bid", requestHeaders, BID_RATE_LIMIT);
  if (!limit.allowed) {
    return {
      status: "error",
      keyString,
      message: `Too many bids from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  const client = getPayPalClient();
  if (client === null) return { status: "error", keyString, message: NOT_SET_UP };
  const profile = await ensureProfile(db, viewer);

  let result;
  try {
    result = await db.transaction(async (tx) =>
      placeBid(tx as unknown as TestDb, {
        client,
        viewer,
        profileId: profile.id,
        listingId,
        spot,
        amountCents: amountUnits * UNIT_CENTS,
        ip: clientIp(requestHeaders),
      }),
    );
  } catch (e) {
    console.error("[spots] bid failed:", e);
    return { status: "error", keyString, message: GENERIC };
  }

  switch (result.outcome) {
    case "not-configured":
      return { status: "error", keyString, message: NOT_SET_UP };
    case "not-owner":
      return { status: "error", keyString, message: "You can only bid for a listing you own." };
    case "not-eligible":
      return { status: "error", keyString, message: eligibilityMessage(result.reason) };
    case "not-your-category":
      return { status: "error", keyString, message: `That spot is for a category your ${siteConfig.entity.singular} is not listed in.` };
    case "no-such-area":
      return { status: "error", keyString, message: "That area does not exist." };
    case "spot-closed":
      return { status: "error", keyString, message: "That spot is closed to bidding at the moment." };
    case "rejected":
      return { status: "error", keyString, message: bidRejectionMessage(result.reason, result.minimum, money) };
    case "unchanged":
      return { status: "applied", keyString, message: "That is already your bid." };
    case "applied":
      revalidateListingPaths(result.paths);
      revalidatePath(`/account/listings/${listingId}/featured`);
      if (result.approveUrl !== null) break;
      return { status: "applied", keyString, message: "Your bid has been lowered and the row re-ranked." };
    case "approval":
      if (result.approveUrl === null) {
        return { status: "error", keyString, message: "PayPal did not give us an approval link. Please try again." };
      }
      break;
  }

  // Outside the try: `redirect` throws.
  redirect(result.approveUrl!);
}

export interface CancelBidState {
  status: "idle" | "cancelled" | "error";
  message?: string;
}

export async function cancelBidAction(_prev: CancelBidState, form: FormData): Promise<CancelBidState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { status: "error", message: "Please sign in." };

  const listingId = String(form.get("listingId") ?? "").trim();
  const spotId = String(form.get("spotId") ?? "").trim();
  if (!isUuid(listingId) || !isUuid(spotId)) return { status: "error", message: GENERIC };

  const requestHeaders = await headers();
  const profile = await ensureProfile(db, viewer);

  let result;
  try {
    result = await db.transaction(async (tx) =>
      cancelOwnBid(tx as unknown as TestDb, {
        client: getPayPalClient(),
        viewer,
        profileId: profile.id,
        listingId,
        spotId,
        ip: clientIp(requestHeaders),
      }),
    );
  } catch (e) {
    console.error("[spots] cancel failed:", e);
    return { status: "error", message: "We could not reach PayPal to stop the charge. Please try again in a few minutes." };
  }

  switch (result.outcome) {
    case "not-owner":
      return { status: "error", message: "That listing was not found." };
    case "no-bid":
      return { status: "error", message: "There is no bid on that spot to cancel." };
    case "applied":
      revalidateListingPaths(result.paths);
      revalidatePath(`/account/listings/${listingId}/featured`);
      return {
        status: "cancelled",
        message:
          result.approveUrl === null
            ? "Your bid is cancelled. You will not be charged for that spot again."
            : "Your bid is cancelled. PayPal will ask you to approve the lower monthly amount.",
      };
  }
}

function eligibilityMessage(reason: "not-published" | "not-verified" | "no-subscription"): string {
  const e = siteConfig.entity;
  switch (reason) {
    case "not-published":
      return `Your ${e.singular} has to be live before it can be featured.`;
    case "not-verified":
      return `Featured spots are for Verified ${e.plural}. Complete verification first.`;
    case "no-subscription":
      return "Featured spots are for listings on a paid plan.";
  }
}
