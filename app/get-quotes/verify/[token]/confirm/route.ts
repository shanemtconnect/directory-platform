import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { isEnabled } from "@/lib/features/flags";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { verifyQuoteToken } from "@/lib/db/queries/quotes";
import {
  createLeadFromCaptureRequest, createLeadFromEnquiryRequest, createLeadFromQuote,
} from "@/lib/db/queries/leads";
import { runAfterLeadCreated } from "@/lib/leads/hooks";
import { notifyQuoteRequest } from "@/lib/email/notify";
import { siteOrigin } from "@/lib/site-env";
import { QUOTE_VERIFY_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import type { TestDb } from "@/lib/db/types";

/**
 * POST /get-quotes/verify/<token>/confirm — the "Confirm my request" button on
 * the page the emailed link opens (Task 56).
 *
 * POST only, deliberately, as the review confirm is. Mail-security scanners,
 * gateway link rewriters, chat previewers and prefetchers all GET the links
 * they find, and any of them confirming a request typed with somebody else's
 * address would send it to businesses — or sell it as a lead. There is no
 * GET export: following this URL without pressing the button is a 405.
 *
 * The button is what sends a request anywhere. In one transaction it
 * marks the request verified (single use — `verifyQuoteToken`), queues the
 * delivery to the recipients chosen at submit (`notify.quote`, exactly the
 * job the form used to queue itself), and — with the lead marketplace on —
 * makes the lead a verified request is owed (D5) and hands it to Task 58's
 * allocation hook, which runs in a savepoint so a failed allocation leaves
 * the lead open and the request verified.
 *
 * An `enquiry` request (an enquiry to an unclaimed listing with no address)
 * is delivered nowhere; its confirmation only makes the enquiry lead.
 *
 * Every outcome ends on /get-quotes/confirmed, which knows how to say it:
 * confirmed, already confirmed, expired, or not a link we recognise.
 */

export const dynamic = "force-dynamic";

type Landing = "verified" | "already" | "expired" | "unknown";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  // Build-time constant: with quotes off this is a 404 like the rest of the module.
  if (!isEnabled("quoteBroadcast")) return new NextResponse(null, { status: 404 });

  // Counted before the token is looked up, in the bucket the landing page
  // shares: a guess loop must not be a free query per guess.
  const limit = await limitPublicWrite("quote-verify", request.headers, QUOTE_VERIFY_RATE_LIMIT);
  if (!limit.allowed) {
    return new NextResponse("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "no-store" },
    });
  }

  const token = decodeURIComponent((await params).token);
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
      const door = {
        quote: createLeadFromQuote,
        capture: createLeadFromCaptureRequest,
        enquiry: createLeadFromEnquiryRequest,
      }[result.source];
      const lead = await door(handle, PUBLIC_VIEWER, result.quoteRequestId);
      if (lead !== null) await runAfterLeadCreated(handle, PUBLIC_VIEWER, lead);
    }
    return "verified";
  });

  // 303 so the browser follows with a GET and the back button cannot
  // resubmit. The token does not appear on the page it lands on.
  return NextResponse.redirect(`${siteOrigin()}/get-quotes/confirmed?state=${landing}`, 303);
}
