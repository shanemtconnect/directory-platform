import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { getPayPalClient } from "@/lib/billing/paypal";
import { processPayPalWebhook } from "@/lib/billing/process";
import type { TestDb } from "@/test/db";

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
 */

// Never prerendered, never cached: it is a POST endpoint with a signature.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The five headers PayPal signs with. */
const SIGNATURE_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
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
    { status: result.status, headers: { "Cache-Control": "no-store" } },
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
