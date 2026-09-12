"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { clientIp } from "@/lib/spam/client-ip";
import { limitPublicWrite } from "@/lib/spam/write-limit";
import { getPayPalClient } from "@/lib/billing/paypal";
import { couponRejectionMessage } from "@/lib/billing/coupons";
import { parseBillingInterval, parseTier } from "@/lib/billing/plans";
import { startCheckout } from "@/lib/billing/subscriptions";
import { previewCoupon } from "@/lib/db/queries/coupons";
import { requestCancellation, subscriptionForOwner } from "@/lib/db/queries/billing";
import { isUuid } from "@/lib/actions/validation";
import type { TestDb } from "@/test/db";

/**
 * The two things an owner can do with money, and one preview that does not
 * touch it.
 *
 * Every one of them re-derives the viewer and the profile here. The layout
 * gate on /account is not a security boundary for an action (global constraint
 * 23), and a checkout page is reachable by anyone who can construct the URL.
 */

/**
 * Ten an hour. Starting a checkout creates a PayPal subscription, so a loose
 * budget here is somebody else's API quota as well as our database.
 */
const CHECKOUT_RATE_LIMIT = { limit: 10, windowSeconds: 3600 } as const;

/** Thirty an hour: typing a code wrong is normal, guessing codes is not. */
const COUPON_RATE_LIMIT = { limit: 30, windowSeconds: 3600 } as const;

export interface CheckoutState {
  status: "idle" | "error";
  message?: string;
  /** Set when the code was the problem, so the field can own the message. */
  couponError?: string;
}

const GENERIC = "Something went wrong starting your subscription. Please try again.";

export async function startCheckoutAction(
  _prev: CheckoutState,
  form: FormData,
): Promise<CheckoutState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") {
    return { status: "error", message: "Please sign in to subscribe." };
  }

  const listingId = String(form.get("listingId") ?? "").trim();
  const tier = parseTier(String(form.get("tier") ?? ""));
  const interval = parseBillingInterval(String(form.get("interval") ?? ""));
  const couponCode = String(form.get("coupon") ?? "").trim();

  if (!isUuid(listingId) || tier === null || interval === null) {
    // All three are hidden fields, so this is a tampered form, not a typo.
    return { status: "error", message: GENERIC };
  }

  const requestHeaders = await headers();
  const limit = await limitPublicWrite("billing-checkout", requestHeaders, CHECKOUT_RATE_LIMIT);
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many attempts from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  const client = getPayPalClient();
  if (client === null) {
    return { status: "error", message: "Card payments are not set up on this site yet." };
  }

  const profile = await ensureProfile(db, viewer);

  let result;
  try {
    result = await db.transaction(async (tx) =>
      startCheckout(tx as unknown as TestDb, {
        client,
        viewer,
        profileId: profile.id,
        listingId,
        tier,
        interval,
        couponCode: couponCode === "" ? null : couponCode,
        ip: clientIp(requestHeaders),
      }),
    );
  } catch (e) {
    // startCheckout throws on a PayPal failure so the transaction rolls back.
    // The buyer gets a sentence; the operator gets the provider's own message.
    console.error("[billing] checkout failed:", e);
    return { status: "error", message: GENERIC };
  }

  switch (result.outcome) {
    case "not-configured":
      return { status: "error", message: "Card payments are not set up on this site yet." };
    case "not-owner":
      return {
        status: "error",
        message: "You can only subscribe for a listing you have claimed.",
      };
    case "no-plan":
      return { status: "error", message: "That plan is not available on this site yet." };
    case "coupon-rejected":
      return { status: "error", couponError: couponRejectionMessage(result.reason) };
    case "approval":
      if (result.approveUrl === null) return { status: "error", message: GENERIC };
      break;
  }

  // Outside the try: `redirect` works by throwing, and catching it here would
  // turn a successful checkout into the generic error above.
  redirect(result.approveUrl!);
}

export interface CouponState {
  status: "idle" | "ok" | "error";
  message?: string;
}

/** Checks a code without spending it, so the page can price the first payment. */
export async function checkCouponAction(
  _prev: CouponState,
  form: FormData,
): Promise<CouponState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { status: "error", message: "Please sign in first." };

  const code = String(form.get("coupon") ?? "").trim();
  if (code === "") return { status: "idle" };

  const tier = parseTier(String(form.get("tier") ?? ""));
  const interval = parseBillingInterval(String(form.get("interval") ?? ""));
  if (tier === null || interval === null) return { status: "error", message: "" };

  const limit = await limitPublicWrite("billing-coupon", await headers(), COUPON_RATE_LIMIT);
  if (!limit.allowed) {
    return { status: "error", message: "Too many attempts. Please try again later." };
  }

  const result = await previewCoupon(db, viewer, { code, tier, interval });
  return result.outcome === "ok"
    ? { status: "ok", message: `Code ${result.coupon.code} applied.` }
    : { status: "error", message: couponRejectionMessage(result.reason) };
}

export interface CancelState {
  status: "idle" | "cancelled" | "error";
  message?: string;
}

export async function cancelSubscriptionAction(
  _prev: CancelState,
  form: FormData,
): Promise<CancelState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { status: "error", message: "Please sign in." };

  const subscriptionId = String(form.get("subscriptionId") ?? "").trim();
  if (!isUuid(subscriptionId)) return { status: "error", message: GENERIC };

  const requestHeaders = await headers();
  const profile = await ensureProfile(db, viewer);

  // The owner check FIRST, before anything is said to PayPal.
  const owned = await subscriptionForOwner(db, viewer, {
    id: subscriptionId,
    profileId: profile.id,
  });
  // Same answer whether it is somebody else's or does not exist.
  if (owned === null) return { status: "error", message: "That subscription was not found." };

  const client = getPayPalClient();
  if (client !== null && owned.providerSubscriptionId !== null) {
    try {
      // PayPal first. Marking our row while PayPal carries on billing is the
      // one failure a customer would find out about on their statement.
      await client.cancelSubscription(
        owned.providerSubscriptionId,
        "Cancelled by the account holder",
      );
    } catch (e) {
      console.error("[billing] PayPal cancel failed:", e);
      return {
        status: "error",
        message: "We could not reach PayPal to cancel. Please try again in a few minutes.",
      };
    }
  }

  const done = await db.transaction(async (tx) =>
    requestCancellation(tx as unknown as TestDb, viewer, {
      subscriptionId,
      profileId: profile.id,
      ip: clientIp(requestHeaders),
    }),
  );
  if (!done) return { status: "error", message: "That subscription was not found." };

  revalidatePath("/account/billing");
  return {
    status: "cancelled",
    message:
      owned.currentPeriodEnd === null
        ? "Your subscription has been cancelled."
        : "Your subscription is cancelled and will not renew.",
  };
}
