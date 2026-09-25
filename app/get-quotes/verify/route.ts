import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { isEnabled } from "@/lib/features/flags";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { verifyQuoteToken } from "@/lib/db/queries/quotes";
import { createLeadFromCaptureRequest, createLeadFromQuote } from "@/lib/db/queries/leads";
import { runAfterLeadCreated } from "@/lib/leads/hooks";
import { notifyQuoteRequest } from "@/lib/email/notify";
import { siteOrigin } from "@/lib/site-env";
import { QUOTE_VERIFY_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import type { TestDb } from "@/lib/db/types";

/**
 * GET /get-quotes/verify?token=… — the link in the requester's email (Task 56).
 *
 * The click is what sends a quote request anywhere. In one transaction it
 * marks the request verified (single use — `verifyQuoteToken`), queues the
 * delivery to the recipients chosen at submit (`notify.quote`, exactly the
 * job the form used to queue itself), and — with the lead marketplace on —
 * makes the lead a verified request is owed (D5) and hands it to Task 58's
 * allocation hook, which runs in a savepoint so a failed allocation leaves
 * the lead open and the request verified.
 *
 * A GET, unlike the review confirm (a POST behind a button), because this is
 * an email-ownership check and the brief makes the link itself the
 * confirmation. See the Task 56 report for the trade-off: a mail scanner that
 * pre-fetches links would confirm on the requester's behalf.
 *
 * Every outcome ends on /get-quotes/confirmed, which knows how to say it:
 * confirmed, already confirmed, expired, or not a link we recognise.
 */

export const dynamic = "force-dynamic";

type Landing = "verified" | "already" | "expired" | "unknown";

export async function GET(request: Request): Promise<Response> {
  // Build-time constant: with quotes off this is a 404 like the rest of the module.
  if (!isEnabled("quoteBroadcast")) return new NextResponse(null, { status: 404 });

  // Counted before the token is looked up: a guess loop must not be a free query per guess.
  const limit = await limitPublicWrite("quote-verify", request.headers, QUOTE_VERIFY_RATE_LIMIT);
  if (!limit.allowed) {
    return new NextResponse("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "no-store" },
    });
  }

  const token = new URL(request.url).searchParams.get("token") ?? "";
  const leadsOn = isEnabled("leadMarketplace");

  const landing = await db.transaction(async (tx): Promise<Landing> => {
    const handle = tx as unknown as TestDb;
    const result = await verifyQuoteToken(handle, PUBLIC_VIEWER, token);
    switch (result.outcome) {
      case "already-verified":
        return "already";
      case "expired":
      case "unknown":
        return result.outcome;
      case "verified":
        break;
    }

    if (result.source === "quote" && result.recipientCount > 0) {
      await notifyQuoteRequest(handle, PUBLIC_VIEWER, result.quoteRequestId);
    }
    if (leadsOn) {
      const lead = result.source === "capture"
        ? await createLeadFromCaptureRequest(handle, PUBLIC_VIEWER, result.quoteRequestId)
        : await createLeadFromQuote(handle, PUBLIC_VIEWER, result.quoteRequestId);
      if (lead !== null) await runAfterLeadCreated(handle, PUBLIC_VIEWER, lead);
    }
    return "verified";
  });

  // 303 so a refresh of the landing page is a plain GET of the landing page,
  // not a second click. The token never appears on the page it lands on.
  return NextResponse.redirect(`${siteOrigin()}/get-quotes/confirmed?state=${landing}`, 303);
}
