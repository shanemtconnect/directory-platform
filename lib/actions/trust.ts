"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { createRemovalRequest, createReport } from "@/lib/db/queries/trust";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { notifyRemoval, notifyReport } from "@/lib/email/notify";
import { clientIp, rateLimitSubject } from "@/lib/spam/client-ip";
import { rateLimit } from "@/lib/spam/rate-limit";
import { isHoneypotTripped, verifyTurnstile } from "@/lib/spam/turnstile";
import { REMOVAL_REQUEST_RATE_LIMIT, REPORT_RATE_LIMIT } from "@/lib/spam/write-limit";
import type { TestDb } from "@/test/db";
import { isUuid } from "./validation";
import { validateRemovalRequest, validateReport } from "./trust-validation";

/**
 * The two trust-and-safety forms.
 *
 * Protected exactly like the enquiry form, in exactly that order — honeypot,
 * validate, rate limit, Turnstile, one transaction — because the order is
 * load-bearing. A Turnstile token is single-use and the budget is a handful an
 * hour, so spending either on a submission that then fails on a typo leaves a
 * person who was trying to correct our data unable to retry.
 *
 * Both end in a redirect rather than an in-place confirmation. These are
 * one-shot actions with nothing to come back to, and a landing page is
 * something a person can be pointed at again ("we have your request") when
 * they write in a week later.
 */

export interface TrustFormState {
  status: "idle" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

/** Where the visitor lands, and where the honeypot pretends to send a bot. */
function thanksPath(kind: "report" | "remove", listingId: string): string {
  return isUuid(listingId) ? `/${kind}/${listingId}/thanks` : "/";
}

function tooManyMessage(retryAfterSeconds: number, noun: string): string {
  return `Too many ${noun} from this connection. Please try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`;
}

export async function submitReport(
  _prev: TrustFormState,
  form: FormData,
): Promise<TrustFormState> {
  // Silent success for the honeypot: telling a bot it was caught just teaches
  // the operator to stop filling that field.
  if (isHoneypotTripped(form.get("company_website"))) {
    redirect(thanksPath("report", String(form.get("listingId") ?? "")));
  }

  const { values, errors } = validateReport(form);
  if (errors) {
    return {
      status: "error",
      fieldErrors: errors,
      // listingId is a hidden field, so its error has nowhere to render.
      message: errors.listingId
        ? "Something went wrong. Please try again."
        : "Please check the fields marked below.",
    };
  }

  const ip = clientIp(await headers());
  const subject = rateLimitSubject(ip);
  const limit = await rateLimit(subject && `report:${subject}`, REPORT_RATE_LIMIT);
  if (!limit.allowed) {
    return { status: "error", message: tooManyMessage(limit.retryAfterSeconds, "reports") };
  }

  const turnstile = await verifyTurnstile(
    (form.get("cf-turnstile-response") as string | null) ?? null,
    ip ?? undefined,
  );
  if (!turnstile.ok) {
    return { status: "error", message: "We couldn't verify that you're human. Please try again." };
  }

  const result = await db.transaction(async (tx) => {
    // Same cast the test harness uses: a transaction handle and the root
    // client expose the same query surface to lib/db/queries.
    const handle = tx as unknown as TestDb;
    const created = await createReport(handle, PUBLIC_VIEWER, { ...values, ip });
    // Enqueued inside the transaction, so the job is committed with the row or
    // not at all — and a dead mail provider is never a slow form.
    await notifyReport(handle, PUBLIC_VIEWER, created);
    return created;
  });
  if (result.outcome === "unknown-listing") {
    return { status: "error", message: "That listing is no longer available." };
  }

  redirect(thanksPath("report", values.listingId));
}

export async function submitRemovalRequest(
  _prev: TrustFormState,
  form: FormData,
): Promise<TrustFormState> {
  if (isHoneypotTripped(form.get("company_website"))) {
    redirect(thanksPath("remove", String(form.get("listingId") ?? "")));
  }

  const { values, errors } = validateRemovalRequest(form);
  if (errors) {
    return {
      status: "error",
      fieldErrors: errors,
      message: errors.listingId
        ? "Something went wrong. Please try again."
        : "Please check the fields marked below.",
    };
  }

  const ip = clientIp(await headers());
  const subject = rateLimitSubject(ip);
  const limit = await rateLimit(subject && `removal:${subject}`, REMOVAL_REQUEST_RATE_LIMIT);
  if (!limit.allowed) {
    return { status: "error", message: tooManyMessage(limit.retryAfterSeconds, "requests") };
  }

  const turnstile = await verifyTurnstile(
    (form.get("cf-turnstile-response") as string | null) ?? null,
    ip ?? undefined,
  );
  if (!turnstile.ok) {
    return { status: "error", message: "We couldn't verify that you're human. Please try again." };
  }

  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const created = await createRemovalRequest(handle, PUBLIC_VIEWER, { ...values, ip });
    await notifyRemoval(handle, PUBLIC_VIEWER, created);
    return created;
  });
  if (result.outcome === "unknown-listing") {
    return { status: "error", message: "That listing is no longer available." };
  }

  redirect(thanksPath("remove", values.listingId));
}
