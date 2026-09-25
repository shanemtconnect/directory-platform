"use server";

import { headers } from "next/headers";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { createQuoteRequest } from "@/lib/db/queries/quotes";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { notifyQuoteVerify } from "@/lib/email/notify";
import { isEnabled } from "@/lib/features/flags";
import { checkLeadRules } from "@/lib/leads/rules";
import { leadRefusal } from "@/lib/leads/refusal";
import { clientIp } from "@/lib/spam/client-ip";
import { isHoneypotTripped, verifyTurnstile } from "@/lib/spam/turnstile";
import { LEAD_CAPTURE_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import type { TestDb } from "@/lib/db/types";
import { validateCaptureLead } from "./quotes-validation";

/**
 * The lead-capture box on the home page and in the rails (flag
 * `leadMarketplace`, Task 56).
 *
 * The get-quotes form's ladder in the get-quotes order — honeypot, validate,
 * budget, Turnstile, one transaction — and the same verification email. The
 * request is stored as a `capture` quote request: never broadcast to
 * anybody, and turned into a lead by the requester's click
 * (app/get-quotes/verify/[token]/confirm/route.ts). The lead rules run here first, so a
 * repeat requester or a number nobody can ring is told now rather than
 * silently dropped after the click (D11); the click runs them again.
 */

export interface LeadCaptureState {
  status: "idle" | "sent" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

const CHECK_FIELDS = "Please check the fields marked below.";

export async function submitCaptureLead(
  _prev: LeadCaptureState,
  form: FormData,
): Promise<LeadCaptureState> {
  if (!isEnabled("leadMarketplace")) {
    return { status: "error", message: "This site does not take requests here." };
  }
  if (isHoneypotTripped(form.get("company_website"))) return { status: "sent" };

  const { values, errors } = validateCaptureLead(form);
  if (errors) return { status: "error", fieldErrors: errors, message: CHECK_FIELDS };

  const requestHeaders = await headers();
  const limit = await limitPublicWrite("lead-capture", requestHeaders, LEAD_CAPTURE_RATE_LIMIT);
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many requests from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  const ip = clientIp(requestHeaders);
  const turnstile = await verifyTurnstile(
    (form.get("cf-turnstile-response") as string | null) ?? null,
    ip ?? undefined,
  );
  if (!turnstile.ok) {
    return { status: "error", message: "We couldn't verify that you're human. Please try again." };
  }

  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const verdict = await checkLeadRules(handle, {
      email: values.email, phone: values.phone, country: siteConfig.country,
    });
    if (verdict !== "ok") return { outcome: "refused" as const, reason: verdict.reason };
    const created = await createQuoteRequest(handle, PUBLIC_VIEWER, { ...values, ip }, { source: "capture" });
    await notifyQuoteVerify(handle, PUBLIC_VIEWER, created);
    return created;
  });

  switch (result.outcome) {
    case "created":
      return { status: "sent" };
    case "refused":
      return { status: "error", ...leadRefusal(result.reason) };
    case "unknown-city":
      return { status: "error", fieldErrors: { cityId: "Please choose a town." }, message: CHECK_FIELDS };
    case "unknown-category":
      return { status: "error", fieldErrors: { categoryId: "Please choose a category." }, message: CHECK_FIELDS };
    case "no-recipients":
    case "lead-refused":
      // Unreachable for a capture request: it picks no recipients, and its
      // rules ran above.
      return { status: "error", message: "Something went wrong. Please try again." };
  }
}
