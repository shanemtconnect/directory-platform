"use server";

import { headers } from "next/headers";
import { db } from "@/lib/db/client";
import { createEnquiry } from "@/lib/db/queries/enquiries";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { notifyEnquiry } from "@/lib/email/notify";
import { clientIp, rateLimitSubject } from "@/lib/spam/client-ip";
import { rateLimit } from "@/lib/spam/rate-limit";
import { verifyTurnstile, isHoneypotTripped } from "@/lib/spam/turnstile";
import { ENQUIRY_RATE_LIMIT } from "@/lib/spam/write-limit";
import type { TestDb } from "@/lib/db/types";
import { validateEnquiry } from "./validation";

export interface EnquiryState {
  status: "idle" | "sent" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

export async function submitEnquiry(
  _prev: EnquiryState,
  form: FormData,
): Promise<EnquiryState> {
  // Silent success for the honeypot: telling a bot it was caught just teaches
  // the operator to stop filling that field.
  if (isHoneypotTripped(form.get("company_website"))) {
    return { status: "sent" };
  }

  // Validation comes first, and that ordering is load-bearing. A Turnstile
  // token is single-use: spending it on a submission that then fails on a
  // typo leaves the visitor unable to retry without solving a new challenge.
  // Nor should a typo cost one of the five hourly attempts.
  const { values, errors } = validateEnquiry(form);
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
  const limit = await rateLimit(subject && `enquiry:${subject}`, ENQUIRY_RATE_LIMIT);
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many enquiries from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  const turnstile = await verifyTurnstile(
    (form.get("cf-turnstile-response") as string | null) ?? null,
    ip ?? undefined,
  );
  if (!turnstile.ok) {
    return { status: "error", message: "We couldn't verify that you're human. Please try again." };
  }

  // The published-only gate and the counter bump both live in the query, and
  // the transaction is here so they land together.
  const result = await db.transaction(async (tx) => {
    // Same cast the test harness uses: a transaction handle and the root
    // client expose the same query surface to lib/db/queries.
    const handle = tx as unknown as TestDb;
    const created = await createEnquiry(handle, PUBLIC_VIEWER, { ...values, ip });
    await notifyEnquiry(handle, PUBLIC_VIEWER, created);
    return created;
  });
  if (result.outcome === "unknown-listing") {
    return { status: "error", message: "That listing is no longer available." };
  }

  // The notification is a queued job committed with the enquiry above, so a
  // dead mail provider cannot cost us the lead — or slow this response down.
  return { status: "sent" };
}
