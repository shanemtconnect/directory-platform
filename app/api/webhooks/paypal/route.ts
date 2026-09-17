import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { getPayPalClient } from "@/lib/billing/paypal";
import { processPayPalWebhook } from "@/lib/billing/process";
import { PAYPAL_WEBHOOK_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import type { TestDb } from "@/lib/db/types";

/**
 * PayPal's delivery endpoint.
 *
 * Everything of substance is in `lib/billing/process.ts`; this file exists to
 * read the raw body, run one transaction and turn the result into a response.
 * Two details it cannot delegate:
 *
 *  - The body is read as TEXT and parsed once, inside the processor, because
 *    the signature is over the bytes PayPal sent.
 *  - `revalidatePath` is a Next primitive and can only be called from here, so
 *    the processor reports which paths changed and this file acts on it. A
 *    listing whose tier has just changed is ranked differently on its city
 *    page, and an ISR cache that still says 'free' is the customer's first
 *    impression of what they just bought.
 *
 * And two things that happen BEFORE the body is read, because everything
 * after it costs something — buffering, a transaction, a verify call to
 * PayPal's API that has its own quota:
 *
 *  - The declared size is checked against a cap. PayPal's events are a few
 *    KB; 256 KB is generous. A POST that declares more, or declares nothing,
 *    is refused without reading a byte. The bytes actually read are checked
 *    again afterwards, because a header is a claim.
 *  - A per-address rate limit. Every delivery used to reach verification,
 *    so anyone who could guess the URL could spend our verify quota until
 *    PayPal's own limiter rejected the genuine event behind the flood.
 */

// Never prerendered, never cached: it is a POST endpoint with a signature.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PayPal's largest events (a subscription with its full plan and billing
 * history inlined) are well under 32 KB. Eight times that leaves nothing a
 * genuine delivery could trip and nothing an attacker can use to make this
 * endpoint buffer a gigabyte.
 */
const MAX_BODY_BYTES = 256 * 1024;

const NO_STORE = { "Cache-Control": "no-store" } as const;

function payloadTooLarge(): Response {
  return Response.json({ outcome: "payload-too-large" }, { status: 413, headers: NO_STORE });
}

/** The five headers PayPal signs with. */
const SIGNATURE_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

export async function POST(request: Request): Promise<Response> {
  // A missing Content-Length is refused with the same answer as an oversized
  // one: PayPal always sends it, and a chunked body of unknown length is
  // exactly the request this cap exists to avoid buffering.
  const declared = request.headers.get("content-length")?.trim() ?? "";
  const declaredLength = declared === "" ? Number.NaN : Number(declared);
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES) {
    return payloadTooLarge();
  }

  const limit = await limitPublicWrite("paypal-webhook", request.headers, PAYPAL_WEBHOOK_RATE_LIMIT);
  if (!limit.allowed) {
    return Response.json(
      { outcome: "rate-limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const raw = await request.text();
  // Byte length, not `raw.length`: a body of multi-byte characters is longer
  // on the wire than in UTF-16 code units, and the header above was a claim.
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return payloadTooLarge();

  const headers: Record<string, string | null> = {};
  for (const name of SIGNATURE_HEADERS) headers[name] = request.headers.get(name);

  const client = getPayPalClient();

  const result = await db.transaction(async (tx) =>
    processPayPalWebhook(tx as unknown as TestDb, { raw, headers, client }),
  );

  if (result.revalidate) {
    revalidatePath(result.revalidate.listingPath);
    revalidatePath(result.revalidate.cityPath);
  }

  return Response.json(
    { outcome: result.outcome, ...(result.detail === undefined ? {} : { detail: result.detail }) },
    { status: result.status, headers: NO_STORE },
  );
}

/**
 * A GET here is somebody poking at the URL, never PayPal. 405 rather than 404:
 * the endpoint exists, and hiding that from an operator testing their webhook
 * configuration helps nobody.
 */
export function GET(): Response {
  return Response.json({ message: "POST only" }, { status: 405 });
}
