"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer, requireAdmin } from "@/lib/auth/viewer";
import {
  createQuoteRequest,
  flagQuoteRequestSpam,
  markQuoteOutcome,
} from "@/lib/db/queries/quotes";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { notifyQuoteVerify } from "@/lib/email/notify";
import { isEnabled } from "@/lib/features/flags";
import { clientIp } from "@/lib/spam/client-ip";
import { isHoneypotTripped, verifyTurnstile } from "@/lib/spam/turnstile";
import { QUOTE_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import type { TestDb } from "@/lib/db/types";
import { isUuid } from "./validation";
import { validateQuoteRequest } from "./quotes-validation";

/**
 * The get-quotes form, protected exactly like the enquiry form and in exactly
 * that order — honeypot, validate, rate limit, Turnstile, one transaction —
 * because the order is load-bearing: a Turnstile token is single-use and the
 * budget is three an hour, so neither may be spent on a submission that then
 * fails on a typo.
 *
 * The flag is checked here as well as on the page. The page 404s when the
 * feature is off, but a server action is a URL of its own, and one that
 * writes to five inboxes must not answer when the site says it does not do
 * this.
 */

export interface QuoteFormState {
  status: "idle" | "sent" | "error";
  /**
   * On "sent": how many businesses the request WILL go to once the
   * requester clicks the verification link. Nobody has been written to yet.
   */
  recipientCount?: number;
  message?: string;
  fieldErrors?: Record<string, string>;
}

export async function submitQuoteRequest(
  _prev: QuoteFormState,
  form: FormData,
): Promise<QuoteFormState> {
  if (!isEnabled("quoteBroadcast")) {
    return { status: "error", message: "Quote requests are not available on this site." };
  }

  // Silent success for the honeypot: telling a bot it was caught just teaches
  // the operator to stop filling that field. The count is the cap, which is
  // what a real submission would most often say.
  if (isHoneypotTripped(form.get("company_website"))) {
    return { status: "sent", recipientCount: siteConfig.quotes.maxRecipients };
  }

  const { values, errors } = validateQuoteRequest(form);
  if (errors) {
    return {
      status: "error",
      fieldErrors: errors,
      message: "Please check the fields marked below.",
    };
  }

  const requestHeaders = await headers();
  const limit = await limitPublicWrite("quote", requestHeaders, QUOTE_RATE_LIMIT);
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many quote requests from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
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

  // Recipients, request, audit row and the queued verification email land
  // together or not at all. The recipients are NOT written to here: the
  // requester's click (app/get-quotes/verify/[token]/confirm/route.ts) is what queues their
  // copies. With the lead marketplace on, a request nobody local can take is
  // kept rather than refused — the click turns it into a lead.
  const allowNoRecipients = isEnabled("leadMarketplace");
  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const created = await createQuoteRequest(handle, PUBLIC_VIEWER, { ...values, ip }, { allowNoRecipients });
    await notifyQuoteVerify(handle, PUBLIC_VIEWER, created);
    return created;
  });

  switch (result.outcome) {
    case "created":
      return { status: "sent", recipientCount: result.recipientCount };
    case "no-recipients":
      return {
        status: "error",
        message: "Nobody in that town and category can take a request right now. Try a nearby town.",
      };
    case "unknown-city":
      return { status: "error", fieldErrors: { cityId: "Please choose a town." }, message: "Please check the fields marked below." };
    case "unknown-category":
      return { status: "error", fieldErrors: { categoryId: "Please choose a category." }, message: "Please check the fields marked below." };
  }
}

/** The owner's verdict on one lead. Scoped inside the query, never here. */
export async function markQuoteLead(
  recipientId: string,
  outcome: "won" | "lost",
): Promise<{ ok: boolean }> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { ok: false };
  if (!isUuid(recipientId)) return { ok: false };

  const ip = clientIp(await headers());
  const ok = await db.transaction(async (tx) =>
    markQuoteOutcome(tx as unknown as TestDb, viewer, recipientId, outcome, ip),
  );
  return { ok };
}

/**
 * The admin's spam flag. `requireAdmin()` here, not the layout: the layout is
 * not a security boundary for an action.
 */
export async function flagQuoteSpam(form: FormData): Promise<{ ok: boolean }> {
  const viewer = await requireAdmin();
  const quoteRequestId = String(form.get("quoteRequestId") ?? "");
  const isSpam = String(form.get("isSpam") ?? "") === "true";
  if (!isUuid(quoteRequestId)) return { ok: false };

  const ip = clientIp(await headers());
  const ok = await db.transaction(async (tx) =>
    flagQuoteRequestSpam(tx as unknown as TestDb, viewer, quoteRequestId, isSpam, ip),
  );
  // A plain <form action>, so the list has to be told it changed.
  if (ok) revalidatePath("/admin/quotes");
  return { ok };
}
