"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { isEnabled } from "@/lib/features/flags";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { currentViewer } from "@/lib/auth/viewer";
import { createReview, createReviewReply } from "@/lib/db/queries/reviews";
import { notifyReviewSubmitted } from "@/lib/email/notify";
import { clientIp, rateLimitSubject } from "@/lib/spam/client-ip";
import { rateLimit } from "@/lib/spam/rate-limit";
import { verifyTurnstile, isHoneypotTripped } from "@/lib/spam/turnstile";
import {
  REVIEW_RATE_LIMIT, REVIEW_REPLY_RATE_LIMIT, limitPublicWrite, retryMessage,
} from "@/lib/spam/write-limit";
import { validateReview } from "@/lib/reviews/validate";
import { isUuid, stripCrlf, normaliseBody } from "@/lib/actions/validation";
import type { TestDb } from "@/test/db";

/**
 * The two review mutations.
 *
 * `submitReview` carries exactly the protections the enquiry form does, in the
 * same order and for the same reasons — honeypot first and silently, then
 * validation (a Turnstile token is single-use and a typo must not spend it or
 * one of the hourly attempts), then the rate limit, then the challenge.
 *
 * What it does NOT do is publish anything. The row is written `pending` and
 * the visitor is told to check their email; everything about a rating becoming
 * public happens at /review/verify.
 */

export interface ReviewState {
  status: "idle" | "sent" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

const OFF: ReviewState = { status: "error", message: "That isn't available on this site." };

export async function submitReview(
  _prev: ReviewState,
  form: FormData,
): Promise<ReviewState> {
  // Build-time constant, so with the flag off this whole action is a refusal
  // and the routes that reach it do not exist.
  if (!isEnabled("reviews")) return OFF;

  // Silent success for the honeypot: telling a bot it was caught only teaches
  // the operator to stop filling that field.
  if (isHoneypotTripped(form.get("company_website"))) {
    return { status: "sent" };
  }

  const { values, errors } = validateReview(form);
  if (errors) {
    return {
      status: "error",
      fieldErrors: errors,
      // listingId is a hidden field, so its error has nowhere to render.
      message: errors.listingId ? "Something went wrong. Please try again." : undefined,
    };
  }

  const ip = clientIp(await headers());
  const subject = rateLimitSubject(ip);
  const limit = await rateLimit(subject && `review:${subject}`, REVIEW_RATE_LIMIT);
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many reviews from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  const turnstile = await verifyTurnstile(
    (form.get("cf-turnstile-response") as string | null) ?? null,
    ip ?? undefined,
  );
  if (!turnstile.ok) {
    return { status: "error", message: "We couldn't verify that you're human. Please try again." };
  }

  // Signed in or not: the viewer is read so the owner of the listing can be
  // refused by account as well as by the address on the listing.
  const viewer = await currentViewer();

  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const created = await createReview(handle, viewer, { ...values, ip });
    // Committed with the review, so a review without a way to confirm it
    // cannot exist and a dead mail provider cannot cost us one.
    await notifyReviewSubmitted(handle, PUBLIC_VIEWER, created);
    return created;
  });

  switch (result.outcome) {
    case "unknown-listing":
      return { status: "error", message: "That listing is no longer available." };
    case "own-listing":
      return {
        status: "error",
        message:
          "This looks like your own listing. Reviews have to come from customers, so we can't accept this one.",
      };
    case "already-reviewed":
      // Deliberately explicit rather than a silent success: the person has
      // written something and is owed a reason it is not going up.
      return {
        status: "error",
        message: "You have already reviewed this one. Write to us if you want to change it.",
      };
    case "created":
      return { status: "sent" };
  }
}

/* ------------------------------------------------------------------- reply */

export interface ReplyState {
  ok: boolean;
  message?: string;
}

const REPLY_MAX = 1000;

/**
 * The owner's single answer to a review.
 *
 * Ownership is proved in the query against `listings.owner_id`, never here and
 * never by the page that rendered the form: the form is rendered client-side
 * on a statically cached page, so it is a convenience, not a gate.
 */
export async function replyToReview(
  _prev: ReplyState,
  form: FormData,
): Promise<ReplyState> {
  if (!isEnabled("reviews")) return { ok: false, message: "That isn't available on this site." };

  const reviewId = stripCrlf(String(form.get("reviewId") ?? "")).trim();
  const body = normaliseBody(String(form.get("body") ?? "")).trim();

  if (!isUuid(reviewId)) return { ok: false, message: "That review could not be found." };
  if (body.length < 10) return { ok: false, message: "Please write a little more." };
  if (body.length > REPLY_MAX) {
    return { ok: false, message: `Please keep it under ${REPLY_MAX} characters.` };
  }

  const requestHeaders = await headers();
  const limit = await limitPublicWrite("review-reply", requestHeaders, REVIEW_REPLY_RATE_LIMIT);
  if (!limit.allowed) return { ok: false, message: retryMessage(limit) };

  const viewer = await currentViewer();
  if (viewer.role === "public") {
    return { ok: false, message: "Sign in to the account that owns this listing to reply." };
  }

  const result = await db.transaction(async (tx) =>
    createReviewReply(tx as unknown as TestDb, viewer, { reviewId, body }),
  );

  switch (result.outcome) {
    case "not-owner":
      return { ok: false, message: "Only the owner of this listing can reply to its reviews." };
    case "already-replied":
      return { ok: false, message: "You have already replied to this review." };
    case "unknown-review":
      return { ok: false, message: "That review could not be found." };
    case "created":
      // The reviews page is ISR-cached; without this the owner's own reply is
      // invisible to them for an hour and they write it again.
      revalidatePath(`${result.listingPath}/reviews`);
      revalidatePath(result.listingPath);
      return { ok: true };
  }
}
